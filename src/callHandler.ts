import WebSocket from "ws";
import { supabase } from "./supabaseClient.js";
import { twilioToOpenAI, openAIToTwilio } from "./audioUtils.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || "";

interface OrderItem {
  name: string;
  quantity: number;
  price: number;
  modifications?: string[];
}

export class CallHandler {
  private twilioWs: WebSocket;
  private openaiWs: WebSocket | null = null;
  private streamSid = "";
  private callSid = "";
  private callerPhone = "";
  private calledNumber = "";
  private restaurantId = "";
  private callLogId = "";
  private callStartTime = Date.now();
  private responseActive = false;
  private currentOrderItems: OrderItem[] = [];
  private orderId = "";

  constructor(twilioWs: WebSocket) {
    this.twilioWs = twilioWs;
  }

  start() {
    console.log("New Twilio WebSocket connection");

    this.twilioWs.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        await this.handleTwilioMessage(msg);
      } catch (err: any) {
        console.error("Twilio message handler error:", err?.message || err);
      }
    });

    this.twilioWs.on("error", (err) => {
      console.error("Twilio WebSocket error:", err);
    });

    this.twilioWs.on("close", async () => {
      console.log(`Twilio WebSocket closed for call ${this.callSid}`);
      await this.handleCallEnd();
      if (this.openaiWs && this.openaiWs.readyState === WebSocket.OPEN) {
        this.openaiWs.close();
      }
    });
  }

  private async handleCallEnd() {
    if (this.callLogId) {
      const duration = Math.round((Date.now() - this.callStartTime) / 1000);
      await supabase
        .from("call_logs")
        .update({
          status: "completed",
          ended_at: new Date().toISOString(),
          duration,
        })
        .eq("id", this.callLogId);

      await supabase
        .from("call_sessions")
        .update({ completed: true })
        .eq("call_sid", this.callSid);
    }
  }

  private async handleTwilioMessage(msg: any) {
    switch (msg.event) {
      case "start":
        await this.handleStart(msg);
        break;
      case "media":
        this.handleMedia(msg);
        break;
      case "stop":
        console.log(`Stream stopped for call ${this.callSid}`);
        await this.handleCallEnd();
        if (this.openaiWs && this.openaiWs.readyState === WebSocket.OPEN) {
          this.openaiWs.close();
        }
        break;
    }
  }

  private async handleStart(msg: any) {
    this.streamSid = msg.start.streamSid;
    this.callSid = msg.start.customParameters?.callSid || "";
    this.callerPhone = msg.start.customParameters?.callerPhone || "";
    this.calledNumber = msg.start.customParameters?.calledNumber || TWILIO_PHONE_NUMBER;
    this.callStartTime = Date.now();

    console.log(`Stream started: ${this.streamSid}, callSid: ${this.callSid}`);

    // Look up restaurant by phone number
    const { data: restaurant } = await supabase
      .from("restaurants")
      .select("*")
      .eq("phone", this.calledNumber)
      .maybeSingle();

    let rest = restaurant;
    if (!rest) {
      const { data: fallback } = await supabase
        .from("restaurants")
        .select("*")
        .limit(1)
        .single();
      rest = fallback;
    }

    if (!rest) {
      console.error("No restaurant found");
      this.twilioWs.close();
      return;
    }

    this.restaurantId = rest.id;

    // Find existing call log
    const { data: callLog } = await supabase
      .from("call_logs")
      .select("id")
      .eq("call_sid", this.callSid)
      .maybeSingle();

    if (callLog) {
      this.callLogId = callLog.id;
    }

    // Load menu
    const { data: menuItems } = await supabase
      .from("menu_items")
      .select("*")
      .eq("restaurant_id", this.restaurantId)
      .eq("available", true);

    const menuText = (menuItems || [])
      .map(
        (item: any) =>
          `- ${item.name} ($${item.price}): ${item.description || "No description"}${
            item.modifications?.length
              ? ` | Modifications: ${item.modifications.join(", ")}`
              : ""
          }`
      )
      .join("\n");

    // Build system prompt
    const systemPrompt =
      rest.system_prompt ||
      `You are a phone assistant for ${rest.name}${rest.cuisine ? `, a ${rest.cuisine} restaurant` : ""}. You are on a live phone call.

RULES:
1. NEVER repeat a question the caller already answered. If they said they want to order, you are now in order-taking mode -- stay there.
2. NEVER re-introduce yourself or re-greet after the first greeting.
3. After adding an order item, say ONLY a short confirmation like "Got it, one margherita" or "Added". Then ask "Anything else?" ONCE.
4. Do NOT read back the full order unless the caller asks or says they are done ordering.
5. If the caller says "that's it", "that's all", or "I'm done", read back the FULL order with prices and total, then ask them to confirm.
6. Keep every response under 2 sentences. This is a phone call, not a chat. Be brief.
7. If you are unsure what has been ordered so far, use the get_current_order tool silently -- do NOT ask the caller to repeat themselves.
8. Track the caller's name, preferences, and any details they mentioned throughout the call -- never ask for information they already gave you.
9. When the caller is ordering, do NOT ask "would you like to place an order?" -- they already ARE ordering.
10. After asking "Anything else?" once and getting no new items, move to confirmation. Do NOT loop.

MENU:
${menuText}

CONVERSATION FLOW:
- Greet briefly -> Ask how you can help -> Take order / Make reservation / Answer question -> Confirm -> Say goodbye
- Once in order-taking mode, STAY in order-taking mode until the caller says they are done.
- Once in reservation mode, collect all details (name, date, time, party size) before confirming.
- Never restart the flow. Never go backwards. Always move forward.

When making a reservation, ask for: name, date, time, and party size.`;

    // Connect to OpenAI Realtime API
    this.openaiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    this.openaiWs.on("open", () => {
      console.log(`OpenAI Realtime connected for call ${this.callSid}`);

      const sessionConfig = {
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          instructions: systemPrompt,
          voice: rest!.voice || "alloy",
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 600,
          },
          tools: [
            {
              type: "function",
              name: "add_order_item",
              description:
                "Add an item to the current order. After this succeeds, briefly confirm (e.g. 'Got it, one margherita'). Then ask 'Anything else?' Do NOT recap the full order unless the caller asks.",
              parameters: {
                type: "object",
                properties: {
                  item_name: { type: "string", description: "Name of the menu item" },
                  quantity: { type: "number", description: "Quantity to order", default: 1 },
                  modifications: {
                    type: "array",
                    items: { type: "string" },
                    description: "Any modifications or special requests",
                  },
                },
                required: ["item_name"],
              },
            },
            {
              type: "function",
              name: "confirm_order",
              description:
                "Finalize and submit the order. Only call this AFTER reading back the complete order to the caller and receiving their explicit confirmation.",
              parameters: {
                type: "object",
                properties: {
                  delivery_address: {
                    type: "string",
                    description: "Delivery address if applicable",
                  },
                },
              },
            },
            {
              type: "function",
              name: "make_reservation",
              description: "Make a reservation at the restaurant.",
              parameters: {
                type: "object",
                properties: {
                  guest_name: { type: "string", description: "Name for the reservation" },
                  date: { type: "string", description: "Date in YYYY-MM-DD format" },
                  time: { type: "string", description: "Time in HH:MM format (24h)" },
                  guest_count: { type: "number", description: "Number of guests" },
                  special_requests: { type: "string", description: "Any special requests" },
                },
                required: ["guest_name", "date", "time", "guest_count"],
              },
            },
            {
              type: "function",
              name: "lookup_menu",
              description:
                "Look up menu items. Use when the caller asks about the menu or specific items.",
              parameters: {
                type: "object",
                properties: {
                  category: {
                    type: "string",
                    description: "Category to filter by (e.g., appetizers, mains, desserts)",
                  },
                  search: {
                    type: "string",
                    description: "Search term to find specific items",
                  },
                },
              },
            },
            {
              type: "function",
              name: "get_current_order",
              description:
                "Get the current order items and running total. Use this silently if you need to check what has been ordered so far instead of asking the caller to repeat themselves.",
              parameters: {
                type: "object",
                properties: {},
              },
            },
          ],
        },
      };

      this.openaiWs!.send(JSON.stringify(sessionConfig));
    });

    this.openaiWs.on("message", async (data) => {
      try {
        const oaiMsg = JSON.parse(data.toString());
        await this.handleOpenAIMessage(oaiMsg, rest!);
      } catch (err: any) {
        console.error("OpenAI message handler error:", err?.message || err);
      }
    });

    this.openaiWs.on("error", (err) => {
      console.error("OpenAI WebSocket error:", err);
    });

    this.openaiWs.on("close", () => {
      console.log(`OpenAI WebSocket closed for call ${this.callSid}`);
    });
  }

  private async handleOpenAIMessage(oaiMsg: any, restaurant: any) {
    if (oaiMsg.type !== "response.audio.delta") {
      console.log(`OpenAI event: ${oaiMsg.type}`);
    }

    switch (oaiMsg.type) {
      case "session.updated": {
        console.log("Session configured, sending greeting");
        const greeting =
          restaurant.greeting_message || `Welcome to ${restaurant.name}! How can I help you today?`;
        this.openaiWs!.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["text", "audio"],
              instructions: `Say exactly this greeting to the caller: "${greeting}"`,
            },
          })
        );
        break;
      }

      case "response.audio.delta": {
        if (oaiMsg.delta && this.streamSid) {
          try {
            const twilioAudio = openAIToTwilio(oaiMsg.delta);
            this.twilioWs.send(
              JSON.stringify({
                event: "media",
                streamSid: this.streamSid,
                media: { payload: twilioAudio },
              })
            );
          } catch (audioErr: any) {
            console.error("Audio conversion error:", audioErr?.message || audioErr);
          }
        }
        break;
      }

      case "response.created":
        this.responseActive = true;
        break;

      case "response.done":
        this.responseActive = false;
        break;

      case "input_audio_buffer.speech_started": {
        if (this.responseActive) {
          this.openaiWs!.send(JSON.stringify({ type: "response.cancel" }));
          this.responseActive = false;
        }
        this.twilioWs.send(JSON.stringify({ event: "clear", streamSid: this.streamSid }));
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        if (oaiMsg.transcript && this.callLogId) {
          supabase
            .from("transcripts")
            .insert({
              call_log_id: this.callLogId,
              role: "caller",
              text: oaiMsg.transcript,
              timestamp: new Date().toISOString(),
            })
            .then(() => {})
            .catch((err) => console.error("Transcript save error:", err));
        }
        break;
      }

      case "response.audio_transcript.done": {
        if (oaiMsg.transcript && this.callLogId) {
          supabase
            .from("transcripts")
            .insert({
              call_log_id: this.callLogId,
              role: "ai",
              text: oaiMsg.transcript,
              timestamp: new Date().toISOString(),
            })
            .then(() => {})
            .catch((err) => console.error("Transcript save error:", err));
        }
        break;
      }

      case "response.function_call_arguments.done": {
        await this.handleFunctionCall(oaiMsg);
        break;
      }

      case "error": {
        console.error("OpenAI error:", oaiMsg.error);
        break;
      }
    }
  }

  private async handleFunctionCall(oaiMsg: any) {
    const fnName = oaiMsg.name;
    const args = JSON.parse(oaiMsg.arguments || "{}");
    let result = "";

    switch (fnName) {
      case "add_order_item": {
        const { data: menuItem } = await supabase
          .from("menu_items")
          .select("*")
          .eq("restaurant_id", this.restaurantId)
          .ilike("name", `%${args.item_name}%`)
          .eq("available", true)
          .limit(1)
          .maybeSingle();

        if (menuItem) {
          const qty = args.quantity || 1;
          this.currentOrderItems.push({
            name: menuItem.name,
            quantity: qty,
            price: menuItem.price,
            modifications: args.modifications,
          });
          const total = this.currentOrderItems.reduce(
            (sum, i) => sum + i.price * i.quantity,
            0
          );
          result = `Added ${qty}x ${menuItem.name} ($${menuItem.price} each). Current order total: $${total.toFixed(2)}. Items in order: ${this.currentOrderItems.map((i) => `${i.quantity}x ${i.name}`).join(", ")}`;
        } else {
          result = `Sorry, I couldn't find "${args.item_name}" on our menu. Could you try again?`;
        }
        break;
      }

      case "confirm_order": {
        if (this.currentOrderItems.length === 0) {
          result = "There are no items in the current order to confirm.";
        } else {
          const total = this.currentOrderItems.reduce(
            (sum, i) => sum + i.price * i.quantity,
            0
          );
          const { data: order } = await supabase
            .from("orders")
            .insert({
              call_log_id: this.callLogId,
              restaurant_id: this.restaurantId,
              items: this.currentOrderItems,
              total,
              delivery_address: args.delivery_address || null,
              status: "confirmed",
            })
            .select("id")
            .single();

          this.orderId = order?.id || "";
          result = `Order confirmed! ${this.currentOrderItems.length} items, total: $${total.toFixed(2)}. Order ID: ${this.orderId}`;

          if (this.callLogId) {
            supabase
              .from("call_logs")
              .update({ type: "order" })
              .eq("id", this.callLogId)
              .then(() => {})
              .catch((err) => console.error("Call log update error:", err));
          }

          this.currentOrderItems = [];
        }
        break;
      }

      case "make_reservation": {
        await supabase
          .from("reservations")
          .insert({
            call_log_id: this.callLogId,
            restaurant_id: this.restaurantId,
            guest_name: args.guest_name,
            date: args.date,
            time: args.time,
            guest_count: args.guest_count || 1,
            special_requests: args.special_requests || null,
            status: "confirmed",
          })
          .select("id")
          .single();

        result = `Reservation confirmed for ${args.guest_name}, party of ${args.guest_count}, on ${args.date} at ${args.time}.`;

        if (this.callLogId) {
          supabase
            .from("call_logs")
            .update({ type: "reservation" })
            .eq("id", this.callLogId)
            .then(() => {})
            .catch((err) => console.error("Call log update error:", err));
        }
        break;
      }

      case "lookup_menu": {
        let query = supabase
          .from("menu_items")
          .select("*")
          .eq("restaurant_id", this.restaurantId)
          .eq("available", true);

        if (args.category) {
          query = query.ilike("category", `%${args.category}%`);
        }
        if (args.search) {
          query = query.or(
            `name.ilike.%${args.search}%,description.ilike.%${args.search}%`
          );
        }

        const { data: items } = await query;
        if (items && items.length > 0) {
          result = items
            .map(
              (i: any) =>
                `${i.name} - $${i.price}${i.description ? `: ${i.description}` : ""}`
            )
            .join("; ");
        } else {
          result = "No matching menu items found.";
        }
        break;
      }

      case "get_current_order": {
        if (this.currentOrderItems.length === 0) {
          result = "No items in the current order yet.";
        } else {
          const total = this.currentOrderItems.reduce(
            (s, i) => s + i.price * i.quantity,
            0
          );
          result = `Current order: ${this.currentOrderItems.map((i) => `${i.quantity}x ${i.name} ($${i.price})`).join(", ")}. Total: $${total.toFixed(2)}`;
        }
        break;
      }

      default:
        result = "Function not recognized.";
    }

    // Send function result back to OpenAI
    this.openaiWs!.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: oaiMsg.call_id,
          output: result,
        },
      })
    );
    this.openaiWs!.send(JSON.stringify({ type: "response.create" }));
  }

  private handleMedia(msg: any) {
    if (this.openaiWs && this.openaiWs.readyState === WebSocket.OPEN) {
      const pcm16Audio = twilioToOpenAI(msg.media.payload);
      this.openaiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: pcm16Audio,
        })
      );
    }
  }
}
