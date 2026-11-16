import { beforeEach, describe, expect, it, vi } from "vitest";

// An answer the app can't read (cut off, or not JSON) is a failed request, never null: the callers read fields from
// it ("Cannot read property 'items' of null"). The server is a stand-in.
const st = vi.hoisted(() => ({ reply: (): Response => new Response("{}") }));
vi.mock("react-native", () => ({ Platform: { constants: { Model: "Test" } } }));
vi.mock("expo/fetch", () => ({ fetch: async () => st.reply() }));

const { api, ApiError } = await import("./api");

describe("api", () => {
  beforeEach(() => { st.reply = () => new Response("{}"); });

  it("gives the server's JSON", async () => {
    st.reply = () => new Response(JSON.stringify({ items: [1], next: "" }));
    expect(await api("GET", "/api/items")).toEqual({ items: [1], next: "" });
  });

  it("fails like a lost connection when the body is cut off", async () => {
    st.reply = () => ({ ok: true, status: 200, headers: new Headers(), text: async () => { throw new Error("The operation was aborted."); } }) as unknown as Response;
    const e = await api("GET", "/api/items").catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(0);
  });

  it("fails when a 200 isn't JSON (a proxy's or captive portal's page) or is empty for a GET", async () => {
    st.reply = () => new Response("<html>Sign in to the Wi-Fi</html>");
    expect((await api("GET", "/api/albums").catch((x) => x)).status).toBe(0);
    st.reply = () => new Response("");
    expect((await api("GET", "/api/albums").catch((x) => x)).status).toBe(0);
    st.reply = () => new Response("null");
    expect((await api("GET", "/api/index?since=0").catch((x) => x)).status).toBe(0);
  });

  it("takes an empty answer to a change as done", async () => {
    st.reply = () => new Response("");
    expect(await api("DELETE", "/api/albums/x")).toBeNull();
  });

  it("still gives the server's message for an error", async () => {
    st.reply = () => new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const e = await api("GET", "/api/albums").catch((x) => x);
    expect(e.status).toBe(404);
    expect(e.message).toMatch(/couldn't be found/);
  });
});

describe("signed out from elsewhere", () => {
  const revokedAnswer = () => new Response(JSON.stringify({ error: "signed out" }), { status: 401, headers: { "X-CF-Session": "revoked" } });

  it("reports it for the app's server and for a background run's own, with the server that said so", async () => {
    const m = await import("./api");
    const told: string[] = [];
    m.whenRevoked((o) => told.push(o));
    m.setServer("https://photos.example.test/");
    st.reply = revokedAnswer;
    await m.api("GET", "/api/items").catch(() => {});
    m.setServer("");
    await m.api("GET", "/api/me/notices", undefined, m.remote("https://photos.example.test")).catch(() => {});
    expect(told).toEqual(["https://photos.example.test", "https://photos.example.test"]);
  });

  it("an answer to a request made before a new sign-in doesn't end the new one", async () => {
    const m = await import("./api");
    const told: string[] = [];
    m.whenRevoked((o) => told.push(o));
    const old = m.remote("https://photos.example.test"); // a background run that started before
    m.newSignIn();
    st.reply = revokedAnswer;
    await m.api("GET", "/api/me/notices", undefined, old).catch(() => {});
    expect(told).toEqual([]);
    await m.api("GET", "/api/me/notices", undefined, m.remote("https://photos.example.test")).catch(() => {});
    expect(told).toEqual(["https://photos.example.test"]);
  });
});
