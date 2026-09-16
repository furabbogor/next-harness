import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const harnessSessions = pgTable("harness_sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  payload: jsonb("payload").notNull(),
});

export type HarnessSessionRow = typeof harnessSessions.$inferSelect;
export type NewHarnessSessionRow = typeof harnessSessions.$inferInsert;
