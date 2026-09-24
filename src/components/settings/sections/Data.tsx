/* ============================================================================
 * Data — where everything you have made is kept, and how to get it somewhere
 * else.
 *
 * The order is the order of the questions: what have I got and how safe is it,
 * how do I take all of it with me, how do I move one piece of it, and where
 * do I get something to start from.
 *
 * Backup and restore used to be in the review loop's Menu — a sheet mounted
 * only while the review loop is on screen — so it did not exist at all from
 * chat, home, the journal or the exam view, and this page's only mention of
 * it was a sentence telling you to go and find it. It is here now, because
 * "can I lose all this" is a settings question and always was.
 * ========================================================================== */
import StorageFacts from "./data/StorageFacts";
import FilesSection from "./data/FilesSection";
import BackupSection from "./data/BackupSection";
import AutoBackupSection from "./data/AutoBackupSection";
import TransferSection from "./data/TransferSection";
import ExamplesSection from "./data/ExamplesSection";

export default function Data() {
  return (
    <>
      <StorageFacts />
      <FilesSection />
      <BackupSection />
      <AutoBackupSection />
      <TransferSection />
      <ExamplesSection />
    </>
  );
}
