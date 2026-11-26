-- Work's chats kept their messages in Mastra's memory, in this database: the threads, what people
-- and the AI wrote in them, and what the memory noted per space. Nothing reads them since the
-- chats are the Bot Server's. A durable turn uses Mastra's store too, for its snapshots only, and
-- makes these three tables again, empty, when it first runs.
DROP TABLE IF EXISTS `mastra_messages`;--> statement-breakpoint
DROP TABLE IF EXISTS `mastra_threads`;--> statement-breakpoint
DROP TABLE IF EXISTS `mastra_resources`;
