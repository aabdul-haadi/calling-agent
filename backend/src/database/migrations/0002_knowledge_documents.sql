-- Vectors change size (256 -> 384). Chunks are rebuilt from the policy files at startup, and nothing else
-- referenced the old ones, so they are dropped first.
DELETE FROM "knowledge_chunks";--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"origin" text DEFAULT 'upload' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text,
	"progress" integer DEFAULT 0 NOT NULL,
	"pages" integer,
	"chunks" integer DEFAULT 0 NOT NULL,
	"ocr_pages" integer DEFAULT 0 NOT NULL,
	"size_bytes" integer,
	"content_hash" text,
	"embedding_model" text,
	"error" jsonb,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ALTER COLUMN "embedding" SET DATA TYPE vector(384);--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "page" integer;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "page_end" integer;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "doc_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(heading, '') || ' ' || content)) STORED;--> statement-breakpoint
CREATE INDEX "knowledge_documents_client_idx" ON "knowledge_documents" USING btree ("client_id","name");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_document_idx" ON "knowledge_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_tsv_idx" ON "knowledge_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_embedding_idx" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);