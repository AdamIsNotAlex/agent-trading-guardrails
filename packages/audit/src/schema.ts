import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const auditEvents = sqliteTable("audit_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: text("event_id").notNull().unique(),
  eventType: text("event_type").notNull(),
  timestamp: text("timestamp").notNull(),
  correlationId: text("correlation_id").notNull(),
  environment: text("environment").notNull(),
  intentId: text("intent_id"),
  principal: text("principal"),
  promptId: text("prompt_id"),
  sessionId: text("session_id"),
  inputRef: text("input_ref"),
  data: text("data").notNull(),
  previousHash: text("previous_hash").notNull(),
  eventHash: text("event_hash").notNull(),
});
