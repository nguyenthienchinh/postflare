import { afterEach, describe, expect, it, vi } from "vitest";
import { commandHelp, parseCommand, splitCommand } from "../src/args.js";
import { UsageError } from "../src/errors.js";
import { COMMANDS, run } from "../src/main.js";

const names = COMMANDS.map((c) => c.name);
const def = (name: string) => COMMANDS.find((c) => c.name === name)!;

describe("splitCommand", () => {
  it("finds one- and two-word commands, with global flags first", () => {
    expect(splitCommand(["post", "--text", "hi"], names)).toMatchObject({ name: "post", rest: ["--text", "hi"] });
    expect(splitCommand(["posts", "show", "pst_1"], names)).toMatchObject({ name: "posts show", rest: ["pst_1"] });
    expect(splitCommand(["--json", "posts", "show", "pst_1"], names)).toMatchObject({ name: "posts show", rest: ["--json", "pst_1"] });
    expect(splitCommand(["--profile", "work", "accounts"], names)).toMatchObject({ name: "accounts", rest: ["--profile", "work"] });
    expect(splitCommand(["platforms", "tiktok"], names)).toMatchObject({ name: "platforms", rest: ["tiktok"] });
    expect(splitCommand(["media"], names)).toMatchObject({ name: "media", rest: [] });
    expect(splitCommand(["media", "upload", "a.jpg", "b.jpg"], names)).toMatchObject({ name: "media upload", rest: ["a.jpg", "b.jpg"] });
    // A value that looks like a subcommand after a flag stays an argument.
    expect(splitCommand(["posts", "--status", "show"], names)).toMatchObject({ name: "posts", rest: ["--status", "show"] });
    expect(splitCommand(["nope"], names).name).toBeNull();
  });
});

describe("parseCommand", () => {
  it("parses repeatable options, short flags and globals", () => {
    const { values, positionals } = parseCommand(def("post"), ["-a", "x", "--account", "bluesky", "-t", "Hi", "--set", "a=1", "--set", "b=2", "--now", "--json"]);
    expect(values.account).toEqual(["x", "bluesky"]);
    expect(values.text).toBe("Hi");
    expect(values.set).toEqual(["a=1", "b=2"]);
    expect(values.now).toBe(true);
    expect(values.json).toBe(true);
    expect(positionals).toEqual([]);
  });

  it("rejects unknown flags and wrong positional counts", () => {
    expect(() => parseCommand(def("post"), ["--bogus"])).toThrow(UsageError);
    expect(() => parseCommand(def("posts show"), [])).toThrow(/Missing argument/);
    expect(() => parseCommand(def("posts show"), ["a", "b"])).toThrow(/Unexpected argument/);
    expect(() => parseCommand(def("post"), ["--text"])).toThrow(UsageError);
    // --help skips the positional checks.
    expect(parseCommand(def("posts show"), ["--help"]).values.help).toBe(true);
  });

  it("every command has help with its options", () => {
    for (const cmd of COMMANDS) {
      const help = commandHelp(cmd);
      expect(help).toContain(`postflare ${cmd.name}`);
      for (const k of Object.keys(cmd.options ?? {})) expect(help).toContain(`--${k}`);
    }
  });
});

describe("run: exit codes", () => {
  let out = "";
  let err = "";
  const capture = () => {
    out = "";
    err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s: any) => ((out += String(s)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((s: any) => ((err += String(s)), true));
  };
  afterEach(() => vi.restoreAllMocks());

  it("0 for help and version, 2 for usage errors, 1 for errors", async () => {
    capture();
    expect(await run(["--help"])).toBe(0);
    expect(out).toContain("Usage: postflare <command>");
    expect(await run(["post", "--help"])).toBe(0);
    expect(out).toContain("--dry-run");
    expect(await run(["help", "posts", "edit"])).toBe(0);
    expect(out).toContain("postflare posts edit <id>");
    expect(await run(["--version"])).toBe(0);
    expect(await run(["frobnicate"])).toBe(2);
    expect(err).toContain('unknown command "frobnicate"');
    expect(await run(["post", "--frob"])).toBe(2);
    const env = { POSTFLARE_CONFIG: "/nonexistent/postflare.json" };
    expect(await run(["accounts"], { env })).toBe(1);
    expect(err).toContain("Not logged in");
  });
});
