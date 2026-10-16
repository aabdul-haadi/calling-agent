CREATE TABLE "knowledge_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"gap_id" uuid,
	"kind" text DEFAULT 'document' NOT NULL,
	"title" text NOT NULL,
	"doc_name" text,
	"attestation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"file_sha256" text,
	"file_path" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"evaluation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"release_id" uuid,
	"reviewer" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shadow_outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"release_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"turn_index" integer NOT NULL,
	"channel" text NOT NULL,
	"customer_text" text NOT NULL,
	"production_reply" text NOT NULL,
	"candidate_reply" text,
	"similarity_pct" integer,
	"candidate_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"dataset_id" uuid,
	"kind" text DEFAULT 'train' NOT NULL,
	"base" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"log_tail" text DEFAULT '' NOT NULL,
	"pid" integer,
	"out_dir" text,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"release_id" uuid,
	"created_by" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "knowledge_proposals_client_idx" ON "knowledge_proposals" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "shadow_outputs_release_idx" ON "shadow_outputs" USING btree ("release_id");--> statement-breakpoint
CREATE INDEX "training_runs_client_idx" ON "training_runs" USING btree ("client_id","started_at");