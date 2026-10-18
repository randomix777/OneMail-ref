-- AlterTable
ALTER TABLE "CalendarConnection" ADD COLUMN     "transport" TEXT NOT NULL DEFAULT 'oauth',
ADD COLUMN     "grantId" TEXT;
