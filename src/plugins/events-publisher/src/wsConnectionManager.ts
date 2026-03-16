import cors from "cors";
import express from "express";
import * as http from "http";
import compression from "compression";
import { WebSocket, WebSocketServer } from "ws";
import { register, Gauge } from "prom-client";
import { EventType, PublicKey } from "@drift-labs/sdk";
import { getEventTypeFromChannel } from "./utils/utils";
import { RedisClient } from "@drift/common/clients";

// Set up env constants
require("dotenv").config();

const app = express();
app.use(cors({ origin: "*" }));
app.use(compression());
app.set("trust proxy", 1);

const wsConnectionsGauge = new Gauge({
  name: "websocket_connections_events",
  help: "Number of active WebSocket connections",
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  perMessageDeflate: true,
});

const WS_PORT = process.env.WS_PORT || "3000";
const RUNNING_LOCAL = process.env.RUNNING_LOCAL === "true";
const MAX_BUFFERED_AMOUNT = 300000;
const REDIS_HOST = process.env.ELASTICACHE_HOST || "localhost";

console.log(`WS LISTENER PORT : ${WS_PORT}`);

const safeGetRawChannelFromMessage = (message: any): string => {
  return message?.channel;
};

const safeGetUserFromMesaage = (message: any): string => {
  return message?.user;
};

const getRedisChannelFromMessage = (message: any): EventType => {
  const channel = message.channel;
  const eventType = getEventTypeFromChannel(channel);
  if (!eventType) {
    throw new Error("Bad channel specified");
  }
  return eventType as string as EventType;
};

const validateUser = (message: any): void => {
  const user = message.user;
  try {
    new PublicKey(user);
  } catch (error) {
    throw new Error("Bad user specified");
  }
};

async function main() {
  const redisClient = new RedisClient({});
  await redisClient.connect();

  const subscribedRedisChannels = new Set<EventType>();
  const channelSubscribers = new Map<EventType, Set<WebSocket>>();
  const userChannelSubscribers = new Map<
    string,
    Map<EventType, Set<WebSocket>>
  >();

  const findUserSubscribersAndSend = (
    user: string,
    channel: EventType,
    message: string,
  ) => {
    const subscribers = userChannelSubscribers
      .get(user)
      ?.get(channel as EventType);
    if (subscribers) {
      subscribers.forEach((ws) => {
        if (
          ws.readyState === WebSocket.OPEN &&
          ws.bufferedAmount < MAX_BUFFERED_AMOUNT
        )
          ws.send(JSON.stringify({ channel: channel, data: message }));
      });
    }
  };

  redisClient.forceGetClient().on("connect", () => {
    subscribedRedisChannels.forEach(async (channel) => {
      try {
        await redisClient.subscribe(channel);
      } catch (error) {
        console.error(`Error subscribing to ${channel}:`, error);
      }
    });
  });

  redisClient
    .forceGetClient()
    .on("message", (subscribedChannel: EventType, message) => {
      const subscribers = channelSubscribers.get(subscribedChannel);
      if (subscribers) {
        subscribers.forEach((ws) => {
          if (
            ws.readyState === WebSocket.OPEN &&
            ws.bufferedAmount < MAX_BUFFERED_AMOUNT
          )
            ws.send(
              JSON.stringify({ channel: subscribedChannel, data: message }),
            );
        });
      }
      const messageObject = JSON.parse(message);
      let user = messageObject.user;
      if (subscribedChannel === "OrderActionRecord") {
        findUserSubscribersAndSend(
          messageObject.taker,
          "OrderActionRecord",
          message,
        );
        findUserSubscribersAndSend(
          messageObject.maker,
          "OrderActionRecord",
          message,
        );
      } else {
        findUserSubscribersAndSend(
          user,
          subscribedChannel as EventType,
          message,
        );
      }
    });

  redisClient.forceGetClient().on("error", (error) => {
    console.error("Redis client error:", error);
  });

  wss.on("connection", (ws: WebSocket) => {
    console.log("Client connected");
    wsConnectionsGauge.inc();

    ws.on("message", async (msg) => {
      let parsedMessage: any;
      let messageType: string;
      try {
        parsedMessage = JSON.parse(msg.toString());
        messageType = parsedMessage.type.toLowerCase();
      } catch (e) {
        return;
      }

      switch (messageType) {
        case "subscribe": {
          // Get the redis channel -- this is required
          let redisChannel: EventType;
          try {
            redisChannel = getRedisChannelFromMessage(parsedMessage);
          } catch (error) {
            const requestChannel = safeGetRawChannelFromMessage(parsedMessage);
            if (requestChannel) {
              ws.send(
                JSON.stringify({
                  channel: requestChannel,
                  error:
                    "Error subscribing to channel with data: " +
                    JSON.stringify(parsedMessage),
                }),
              );
            } else {
              ws.close(
                1003,
                JSON.stringify({
                  error:
                    "Error subscribing to channel with data: " +
                    JSON.stringify(parsedMessage),
                }),
              );
            }
            return;
          }

          // Get the user -- this is optional
          let user = safeGetUserFromMesaage(parsedMessage);
          if (user) {
            try {
              validateUser(parsedMessage);
            } catch (error) {
              ws.send(
                JSON.stringify({
                  error:
                    "Error subscribing to user with data: " +
                    JSON.stringify(parsedMessage),
                }),
              );
              return;
            }
          }

          // Subscribe to redis channel if no users subscribed to this event type yet
          if (!subscribedRedisChannels.has(redisChannel)) {
            console.log("Trying to subscribe to channel", redisChannel);
            redisClient
              .subscribe(redisChannel)
              .then(() => {
                subscribedRedisChannels.add(redisChannel);
              })
              .catch(() => {
                ws.send(
                  JSON.stringify({
                    error: `Error subscribing to channel: ${parsedMessage}`,
                  }),
                );
                return;
              });
          }

          // Put subscription in the channel that subs to all events
          if (!user) {
            if (!channelSubscribers.get(redisChannel)) {
              const subscribers = new Set<WebSocket>();
              channelSubscribers.set(redisChannel, subscribers);
            }
            channelSubscribers.get(redisChannel)?.add(ws);
          } else {
            if (!userChannelSubscribers.get(user)) {
              const subscribers = new Map<EventType, Set<WebSocket>>();
              userChannelSubscribers.set(user, subscribers);
            }
            const userSubscribers = userChannelSubscribers.get(user);
            if (!userSubscribers.get(redisChannel as EventType)) {
              const subscribers = new Set<WebSocket>();
              userSubscribers.set(redisChannel as EventType, subscribers);
            }
            userChannelSubscribers
              .get(user)
              .get(redisChannel as EventType)
              ?.add(ws);
          }

          ws.send(
            JSON.stringify({
              message: `Subscribe received for channel: ${parsedMessage.channel}, user: ${parsedMessage.user}`,
            }),
          );
          break;
        }
        case "unsubscribe": {
          let redisChannel: EventType;
          try {
            redisChannel = getRedisChannelFromMessage(parsedMessage);
          } catch (error: any) {
            const requestChannel = safeGetRawChannelFromMessage(parsedMessage);
            if (requestChannel) {
              console.log("Error unsubscribing from channel:", error.message);
              ws.send(
                JSON.stringify({
                  channel: requestChannel,
                  error:
                    "Error unsubscribing from channel with data: " +
                    JSON.stringify(parsedMessage),
                }),
              );
            } else {
              ws.close(
                1003,
                JSON.stringify({
                  error:
                    "Error unsubscribing from channel with data: " +
                    JSON.stringify(parsedMessage),
                }),
              );
            }
            return;
          }

          // Get the user -- this is optional
          let user = safeGetUserFromMesaage(parsedMessage);
          if (user) {
            try {
              validateUser(parsedMessage);
            } catch (error) {
              ws.send(
                JSON.stringify({
                  error:
                    "Error subscribing to user with data: " +
                    JSON.stringify(parsedMessage),
                }),
              );
              return;
            }
          }

          if (!user) {
            if (!channelSubscribers.get(redisChannel)) {
              const subscribers = new Set<WebSocket>();
              channelSubscribers.set(redisChannel, subscribers);
            }
            channelSubscribers.get(redisChannel)?.delete(ws);
          } else {
            userChannelSubscribers
              .get(user)
              ?.get(redisChannel as EventType)
              ?.delete(ws);
            if (
              userChannelSubscribers.get(user)?.get(redisChannel as EventType)
                ?.size === 0
            ) {
              userChannelSubscribers
                .get(user)
                ?.delete(redisChannel as EventType);
            }
          }
          break;
        }
        case undefined:
        default:
          break;
      }
    });

    // Set interval to send heartbeat every 5 seconds
    const heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ channel: "heartbeat" }));
      } else {
        clearInterval(heartbeatInterval);
      }
    }, 5000);

    // Buffer overflow check interval
    const bufferInterval = setInterval(() => {
      if (ws.bufferedAmount > MAX_BUFFERED_AMOUNT) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1008, "Buffer overflow");
        }
        clearInterval(bufferInterval);
      }
    }, 10000);

    // Handle disconnection
    ws.on("close", () => {
      console.log("Client disconnected");
      // Clear any existing intervals
      clearInterval(heartbeatInterval);
      clearInterval(bufferInterval);
      channelSubscribers.forEach((subscribers, channel) => {
        if (subscribers.delete(ws) && subscribers.size === 0) {
          redisClient.unsubscribe(channel);
          channelSubscribers.delete(channel);
          subscribedRedisChannels.delete(channel);
        }
      });
      userChannelSubscribers.forEach((subscribers, user) => {
        subscribers.forEach((subscribers, channel) => {
          if (subscribers.delete(ws) && subscribers.size === 0) {
            userChannelSubscribers.get(user)?.delete(channel);
          }
        });
        if (subscribers.size === 0) {
          userChannelSubscribers.delete(user);
        }
      });
      wsConnectionsGauge.dec();
    });

    ws.on("error", (error) => {
      console.error("Socket error:", error);
    });
  });

  server.listen(WS_PORT, () => {
    console.log(`connection manager running on ${WS_PORT}`);
  });

  app.get("/metrics", async (req, res) => {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  });

  server.on("error", (error) => {
    console.error("Server error:", error);
  });
}

main();
