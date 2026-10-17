import { messages } from "./i18n";
import { randomUUID } from "node:crypto";
import { PLUGIN_CLI_OUTPUT_MAX_BYTES, type BbPluginApi } from "@get-bb/plugin-sdk";
import { bookmarkSchema, listInput, rpcContract, type Bookmark } from "./contract";

export default function plugin(bb: BbPluginApi) {
  bb.settings.define({
    language: {
      type: "select",
      label: `${messages.en.language} / ${messages["zh-CN"].language}`,
      description: `${messages.en.languageHelp} / ${messages["zh-CN"].languageHelp}`,
      options: ["auto", "en", "zh-CN"],
      experimental_optionLabels: { auto: `${messages.en.auto} / ${messages["zh-CN"].auto}`, en: "English", "zh-CN": "简体中文" },
      default: "auto",
    },
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE bookmarks (id TEXT PRIMARY KEY, threadId TEXT NOT NULL, messageSeq INTEGER NOT NULL, projectId TEXT NOT NULL, projectName TEXT NOT NULL, threadTitle TEXT NOT NULL, text TEXT NOT NULL, note TEXT NOT NULL, createdAt TEXT NOT NULL)`,
    `CREATE INDEX bookmarks_recent ON bookmarks(createdAt DESC, id DESC)`,
    `CREATE INDEX bookmarks_project ON bookmarks(projectId, createdAt DESC, id DESC)`,
  ]);
  const get = (id: string) => {
    const row = db.prepare("SELECT * FROM bookmarks WHERE id = ?").get(id);
    if (!row) return null;
    const bookmark = bookmarkSchema.parse(row);
    return bookmark.threadTitle === messages["zh-CN"].untitled ? { ...bookmark, threadTitle: "" } : bookmark;
  };
  // Older versions stored the placeholder instead of the host's automatic title.
  // Repair only missing snapshots, so SQL title search and existing bookmarks agree.
  const repairTitle = async (threadId: string) => {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      const title = thread.title || thread.titleFallback;
      if (title) db.prepare(
        "UPDATE bookmarks SET threadTitle = ? WHERE threadId = ? AND (threadTitle = '' OR threadTitle = ?)",
      ).run(title, threadId, messages["zh-CN"].untitled);
    } catch {
      // Deleted or unavailable threads must not make the saved text unreadable.
    }
  };
  const repairMissingTitles = async () => {
    const rows = db.prepare(
      "SELECT DISTINCT threadId FROM bookmarks WHERE threadTitle = '' OR threadTitle = ?",
    ).all(messages["zh-CN"].untitled) as { threadId: string }[];
    await Promise.all(rows.map(({ threadId }) => repairTitle(threadId)));
  };
  const list = async (input: ReturnType<typeof listInput.parse>) => {
    await repairMissingTitles();
    const term = `%${input.query.replace(/[\\%_]/g, "\\$&")}%`;
    const where = `WHERE (? IS NULL OR projectId = ?) AND (text LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\' OR threadTitle LIKE ? ESCAPE '\\' OR projectName LIKE ? ESCAPE '\\')`;
    const values = [input.projectId ?? null, input.projectId ?? null, term, term, term, term];
    const bookmarks = db
      .prepare(`SELECT * FROM bookmarks ${where} ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...values, input.limit, input.offset)
      .map((row) => {
        const bookmark = bookmarkSchema.parse(row);
        return bookmark.threadTitle === messages["zh-CN"].untitled ? { ...bookmark, threadTitle: "" } : bookmark;
      });
    const count = db.prepare(`SELECT count(*) AS total FROM bookmarks ${where}`).get(...values);
    const total = Number((count as { total: number }).total);
    return { bookmarks, total };
  };
  const changed = () => bb.realtime.publish("changed", {});
  const remove = (id: string) => {
    const removed = db.prepare("DELETE FROM bookmarks WHERE id = ?").run(id).changes > 0;
    if (removed) changed();
    return { removed };
  };
  bb.rpc.register(rpcContract, {
    list,
    async add(input) {
      const thread = await bb.sdk.threads.get({ threadId: input.threadId });
      const project = await bb.sdk.projects.get({ projectId: thread.projectId });
      const bookmark: Bookmark = {
        ...input,
        id: randomUUID(),
        projectId: thread.projectId,
        projectName: project.name,
        threadTitle: thread.title || thread.titleFallback || "",
        note: "",
        createdAt: new Date().toISOString(),
      };
      db.prepare(
        "INSERT INTO bookmarks (id, threadId, messageSeq, projectId, projectName, threadTitle, text, note, createdAt) VALUES (@id, @threadId, @messageSeq, @projectId, @projectName, @threadTitle, @text, @note, @createdAt)",
      ).run(bookmark);
      changed();
      return bookmark;
    },
    note({ id, note }) {
      if (!get(id)) throw new Error(`Bookmark not found: ${id}`);
      db.prepare("UPDATE bookmarks SET note = ? WHERE id = ?").run(note, id);
      changed();
      return get(id)!;
    },
    remove: ({ id }) => remove(id),
  });
  const usage =
    "bb bookmarks list [--project <project-id>] [--limit <1-200>] [--offset <n>] [--json]\nbb bookmarks show <id> [--json]\nbb bookmarks rm <id> [--json]";
  bb.cli.register({
    name: "bookmarks",
    summary: "View and delete conversation bookmarks",
    commands: [
      { name: "list", summary: "List recent bookmarks, optionally filtered by project", usage: usage.split("\n")[0] },
      { name: "show", summary: "Show a complete bookmark", usage: usage.split("\n")[1] },
      { name: "rm", summary: "Delete a bookmark", usage: usage.split("\n")[2] },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => arg !== "--json");
      const reply = (value: unknown) => {
        const stdout = JSON.stringify(value, null, json ? undefined : 2);
        if (Buffer.byteLength(stdout) > PLUGIN_CLI_OUTPUT_MAX_BYTES)
          return {
            exitCode: 1,
            stderr: json
              ? JSON.stringify({ error: "Output too large; reduce --limit and read in pages" })
              : "Output too large; reduce --limit and read in pages",
          };
        return { exitCode: 0, stdout };
      };
      const fail = (message: string) => ({
        exitCode: 1,
        stderr: json ? JSON.stringify({ error: message }) : message,
      });
      if (!command || command === "--help" || command === "help")
        return { exitCode: 0, stdout: usage };
      if (command === "list") {
        const options: Record<string, string | number> = {};
        for (let i = 0; i < args.length; i += 2) {
          const flag = args[i],
            value = args[i + 1];
          if (!value || !["--project", "--limit", "--offset"].includes(flag)) return fail(usage);
          const key = flag === "--project" ? "projectId" : flag.slice(2);
          if (key in options) return fail(`Duplicate argument: ${flag}`);
          options[key] = flag === "--project" ? value : Number(value);
        }
        const parsed = listInput.safeParse(options);
        if (!parsed.success) return fail(usage);
        return reply(await list(parsed.data));
      }
      if ((command === "show" || command === "rm") && args.length === 1) {
        let bookmark = get(args[0]);
        if (command === "show" && bookmark && (!bookmark.threadTitle || bookmark.threadTitle === messages["zh-CN"].untitled)) {
          await repairTitle(bookmark.threadId);
          bookmark = get(args[0]);
        }
        if (!bookmark) return fail(`Bookmark not found: ${args[0]}`);
        return reply(command === "show" ? bookmark : { id: args[0], ...remove(args[0]) });
      }
      return fail(usage);
    },
  });
}
