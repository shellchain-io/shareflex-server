-- AlterTable
ALTER TABLE "Movie" ADD COLUMN "cdnUploaded" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Movie" ADD COLUMN "cloudRegistered" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Episode" ADD COLUMN "cdnUploaded" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Episode" ADD COLUMN "cloudRegistered" BOOLEAN NOT NULL DEFAULT false;
