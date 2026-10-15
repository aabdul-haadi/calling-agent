CREATE TABLE "learning_datasets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"example_ids" jsonb NOT NULL,
	"stats" jsonb NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_gaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"topic_key" text NOT NULL,
	"label" text NOT NULL,
	"examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"occurrences" integer DEFAULT 0 NOT NULL,
	"channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"suggestion" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text,
	"kind" text NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "learning_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"turn_index" integer NOT NULL,
	"channel" text NOT NULL,
	"intent" text DEFAULT 'unknown' NOT NULL,
	"sentiment" text DEFAULT 'neutral' NOT NULL,
	"customer_text" text NOT NULL,
	"ai_reply" text DEFAULT '' NOT NULL,
	"human_reply" text,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"asks_policy" boolean DEFAULT false NOT NULL,
	"abstained" boolean DEFAULT false NOT NULL,
	"tool_outcomes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"handoff_reason" text,
	"low_confidence" boolean DEFAULT false NOT NULL,
	"latency_ms" integer,
	"resolution" text DEFAULT 'unknown' NOT NULL,
	"rating" integer,
	"correction" text,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_hash" text NOT NULL,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"reviewer" text,
	"review_note" text,
	"approved_reply" text,
	"uses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"split" text DEFAULT 'train' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"kind" text NOT NULL,
	"channel" text DEFAULT 'both' NOT NULL,
	"version" integer NOT NULL,
	"dataset_id" uuid,
	"params" jsonb NOT NULL,
	"evaluation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"rollback_to" uuid,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deployed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "learning_datasets_version_idx" ON "learning_datasets" USING btree ("client_id","kind","version");--> statement-breakpoint
CREATE UNIQUE INDEX "learning_gaps_topic_idx" ON "learning_gaps" USING btree ("client_id","topic_key");--> statement-breakpoint
CREATE INDEX "learning_jobs_started_idx" ON "learning_jobs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "learning_turns_client_idx" ON "learning_turns" USING btree ("client_id","review_status");--> statement-breakpoint
CREATE INDEX "learning_turns_conversation_idx" ON "learning_turns" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "learning_turns_dedupe_idx" ON "learning_turns" USING btree ("client_id","dedupe_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "model_releases_version_idx" ON "model_releases" USING btree ("client_id","kind","channel","version");