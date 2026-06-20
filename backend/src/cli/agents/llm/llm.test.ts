import { describe, expect, it, vi } from "vitest";
import { GeminiLlmProvider, __testing } from "./gemini-client.js";
import { OpenAILlmProvider } from "./openai-client.js";
import { GroqLlmProvider } from "./groq-client.js";
import { FallbackLlmProvider, AggregateLlmError } from "./fallback-chain.js";
import { LlmProviderError, type LlmResponse } from "./types.js";

type FetchResponse = Response | (Partial<Response> & { ok: boolean; status: number; text: () => Promise<string> });

function jsonResponse(body: unknown, status = 200): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as FetchResponse;
}

function textResponse(body: string, status: number): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as FetchResponse;
}

function buildFetch(responses: FetchResponse[]): typeof fetch {
  const queue = [...responses];
  const fetchImpl = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("fetch called more times than expected");
    return next as Response;
  });
  return fetchImpl as unknown as typeof fetch;
}

describe("GeminiLlmProvider", () => {
  const GEMINI_BASE_URL = "https://example.test/v1beta";

  it("builds the v1beta request body with systemInstruction + contents + generationConfig", () => {
    const body = __testing.buildGeminiRequestBody({
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hello" },
      ],
      temperature: 0.7,
      topP: 0.9,
      includeThoughts: true,
      thinkingBudget: 1024,
    });
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: "you are helpful" }] },
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      generationConfig: {
        temperature: 0.7,
        topP: 0.9,
        thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 },
      },
    });
  });

  it("omits systemInstruction when there is no system message", () => {
    const body = __testing.buildGeminiRequestBody({
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.5,
    });
    expect(body).not.toHaveProperty("systemInstruction");
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
    expect(body.generationConfig).toEqual({ temperature: 0.5 });
  });

  it("sends the request to the v1beta generateContent endpoint and parses text parts", async () => {
    const fetchImpl = buildFetch([
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ text: '{"action":"wait","quantity":0,"price":1,"reasoning":"x"}' }],
              role: "model",
            },
          },
        ],
        modelVersion: "gemini-3.1-flash-lite",
      }),
    ]);
    const provider = new GeminiLlmProvider({
      apiKey: "sk-test",
      baseUrl: GEMINI_BASE_URL,
      fetchImpl,
    });
    const response = await provider.complete({
      messages: [{ role: "user", content: "go" }],
    });
    expect(response.text).toBe('{"action":"wait","quantity":0,"price":1,"reasoning":"x"}');
    expect(response.provider).toBe("gemini");
    expect(response.model).toBe("gemini-3.1-flash-lite");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const firstCall = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(firstCall).toBeDefined();
    const [url, init] = firstCall as [unknown, RequestInit];
    expect(String(url)).toBe(
      `${GEMINI_BASE_URL}/models/gemini-3.1-flash-lite:generateContent`,
    );
    const requestInit = init as RequestInit;
    expect(requestInit.method).toBe("POST");
    expect((requestInit.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });

  it("strips a trailing slash from baseUrl before hitting the wire", async () => {
    const fetchImpl = buildFetch([
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "ok" }], role: "model" } }],
      }),
    ]);
    const provider = new GeminiLlmProvider({
      apiKey: "sk-test",
      baseUrl: `${GEMINI_BASE_URL}////`,
      fetchImpl,
    });
    await provider.complete({ messages: [{ role: "user", content: "go" }] });
    const firstCall = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    const [url] = firstCall as [unknown, RequestInit];
    expect(String(url)).toBe(`${GEMINI_BASE_URL}/models/gemini-3.1-flash-lite:generateContent`);
  });

  it("separates thought parts from visible parts", async () => {
    const fetchImpl = buildFetch([
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                { text: "thinking aloud", thought: true },
                { text: "FINAL_JSON" },
              ],
            },
          },
        ],
      }),
    ]);
    const provider = new GeminiLlmProvider({
      apiKey: "sk-test",
      baseUrl: GEMINI_BASE_URL,
      fetchImpl,
    });
    const response = await provider.complete({ messages: [{ role: "user", content: "go" }] });
    expect(response.text).toBe("FINAL_JSON");
    expect(response.thoughts).toBe("thinking aloud");
  });

  it("throws a transient LlmProviderError on 5xx", async () => {
    const fetchImpl = buildFetch([textResponse("upstream gone", 503)]);
    const provider = new GeminiLlmProvider({
      apiKey: "sk-test",
      baseUrl: GEMINI_BASE_URL,
      fetchImpl,
    });
    await expect(
      provider.complete({ messages: [{ role: "user", content: "go" }] }),
    ).rejects.toMatchObject({
      provider: "gemini",
      kind: "server",
      status: 503,
      transient: true,
    });
  });

  it("throws a NON-transient LlmProviderError on 401", async () => {
    const fetchImpl = buildFetch([textResponse("unauthorized", 401)]);
    const provider = new GeminiLlmProvider({
      apiKey: "sk-test",
      baseUrl: GEMINI_BASE_URL,
      fetchImpl,
    });
    await expect(
      provider.complete({ messages: [{ role: "user", content: "go" }] }),
    ).rejects.toMatchObject({
      provider: "gemini",
      kind: "auth",
      status: 401,
      transient: false,
    });
  });

  it("classifies 429 as rate_limit and transient", () => {
    expect(__testing.classifyKindFromStatus(429, undefined)).toBe("rate_limit");
  });

  it("requires a non-empty apiKey at construction time", () => {
    expect(() => new GeminiLlmProvider({ apiKey: "", baseUrl: GEMINI_BASE_URL })).toThrow(
      LlmProviderError,
    );
  });

  it("requires a non-empty baseUrl at construction time", () => {
    // Cast through `unknown` for the "no baseUrl at all" case — the
    // type system rejects it at compile time, which is exactly what we
    // want callers to see, but the runtime guard must also fire if
    // someone constructs the provider dynamically (e.g. via the env
    // loader before Zod refinement has run).
    const noBaseUrl = { apiKey: "sk-test" } as unknown as {
      apiKey: string;
      baseUrl: string;
    };
    expect(() => new GeminiLlmProvider(noBaseUrl)).toThrow(LlmProviderError);
    expect(() => new GeminiLlmProvider({ apiKey: "sk-test", baseUrl: "" })).toThrow(
      LlmProviderError,
    );
    expect(() => new GeminiLlmProvider({ apiKey: "sk-test", baseUrl: "   " })).toThrow(
      LlmProviderError,
    );
    try {
      new GeminiLlmProvider(noBaseUrl);
    } catch (err) {
      expect((err as LlmProviderError).kind).toBe("config");
      expect((err as LlmProviderError).transient).toBe(false);
      expect((err as LlmProviderError).message).toMatch(/baseUrl/i);
    }
  });
});

describe("OpenAILlmProvider", () => {
  const OPENAI_BASE_URL = "https://example.test/openai/v1";

  it("sends a chat completions request and reads choices[0].message.content", async () => {
    const fetchImpl = buildFetch([
      jsonResponse({
        id: "chatcmpl-1",
        model: "gpt-5-nano",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"action":"wait","quantity":0,"price":1,"reasoning":"x"}' } }],
      }),
    ]);
    const provider = new OpenAILlmProvider({
      apiKey: "sk-test",
      baseUrl: OPENAI_BASE_URL,
      fetchImpl,
      model: "gpt-5-nano",
    });
    const response = await provider.complete({ messages: [{ role: "user", content: "go" }] });
    expect(response.text).toBe('{"action":"wait","quantity":0,"price":1,"reasoning":"x"}');
    expect(response.provider).toBe("openai");
    expect(response.model).toBe("gpt-5-nano");
    const firstCall = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(firstCall).toBeDefined();
    const [url] = firstCall as [unknown, RequestInit];
    expect(String(url)).toBe(`${OPENAI_BASE_URL}/chat/completions`);
  });

  it("captures reasoning_content as thoughts when the provider exposes it", async () => {
    const fetchImpl = buildFetch([
      jsonResponse({
        choices: [
          {
            message: {
              content: "FINAL",
              reasoning_content: "internal thoughts",
            },
          },
        ],
      }),
    ]);
    const provider = new OpenAILlmProvider({
      apiKey: "sk-test",
      baseUrl: OPENAI_BASE_URL,
      fetchImpl,
    });
    const response = await provider.complete({ messages: [{ role: "user", content: "go" }] });
    expect(response.text).toBe("FINAL");
    expect(response.thoughts).toBe("internal thoughts");
  });

  it("throws empty-shape error on choices[0].message.content === ''", async () => {
    const fetchImpl = buildFetch([
      jsonResponse({ choices: [{ message: { role: "assistant", content: "" } }] }),
    ]);
    const provider = new OpenAILlmProvider({
      apiKey: "sk-test",
      baseUrl: OPENAI_BASE_URL,
      fetchImpl,
    });
    await expect(
      provider.complete({ messages: [{ role: "user", content: "go" }] }),
    ).rejects.toMatchObject({ provider: "openai", kind: "empty" });
  });

  it("requires a non-empty baseUrl at construction time", () => {
    const noBaseUrl = { apiKey: "sk-test" } as unknown as {
      apiKey: string;
      baseUrl: string;
    };
    expect(() => new OpenAILlmProvider(noBaseUrl)).toThrow(LlmProviderError);
    expect(() => new OpenAILlmProvider({ apiKey: "sk-test", baseUrl: "" })).toThrow(
      LlmProviderError,
    );
    try {
      new OpenAILlmProvider(noBaseUrl);
    } catch (err) {
      expect((err as LlmProviderError).kind).toBe("config");
      expect((err as LlmProviderError).message).toMatch(/baseUrl/i);
    }
  });
});

describe("GroqLlmProvider", () => {
  const GROQ_BASE_URL = "https://example.test/groq/openai/v1";

  it("sends a chat completions request and reads choices[0].message.content", async () => {
    const fetchImpl = buildFetch([
      jsonResponse({
        id: "groq-1",
        model: "qwen/qwen3-32b",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"action":"submit","quantity":1,"price":1,"reasoning":"ok"}' } }],
      }),
    ]);
    const provider = new GroqLlmProvider({
      apiKey: "gsk-test",
      baseUrl: GROQ_BASE_URL,
      fetchImpl,
    });
    const response = await provider.complete({ messages: [{ role: "user", content: "go" }] });
    expect(response.text).toBe('{"action":"submit","quantity":1,"price":1,"reasoning":"ok"}');
    expect(response.provider).toBe("groq");
  });

  it("classifies a network failure as transient", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const provider = new GroqLlmProvider({
      apiKey: "gsk-test",
      baseUrl: GROQ_BASE_URL,
      fetchImpl,
    });
    await expect(
      provider.complete({ messages: [{ role: "user", content: "go" }] }),
    ).rejects.toMatchObject({
      provider: "groq",
      kind: "network",
      transient: true,
    });
  });

  it("requires a non-empty baseUrl at construction time", () => {
    const noBaseUrl = { apiKey: "gsk-test" } as unknown as {
      apiKey: string;
      baseUrl: string;
    };
    expect(() => new GroqLlmProvider(noBaseUrl)).toThrow(LlmProviderError);
    expect(() => new GroqLlmProvider({ apiKey: "gsk-test", baseUrl: "" })).toThrow(
      LlmProviderError,
    );
    try {
      new GroqLlmProvider(noBaseUrl);
    } catch (err) {
      expect((err as LlmProviderError).kind).toBe("config");
      expect((err as LlmProviderError).message).toMatch(/baseUrl/i);
    }
  });
});

describe("FallbackLlmProvider", () => {
  function fixedProvider(id: string, response: LlmResponse | Error): { provider: { id: string; model: string; complete: () => Promise<LlmResponse> } } {
    return {
      provider: {
        id,
        model: `${id}-model`,
        complete: async () => {
          if (response instanceof Error) throw response;
          return response;
        },
      },
    };
  }

  it("returns the first provider's response when it succeeds", async () => {
    const a = fixedProvider("a", { text: "ok", thoughts: "", provider: "a", model: "am" });
    const chain = new FallbackLlmProvider({ providers: [a.provider] });
    const out = await chain.complete({ messages: [{ role: "user", content: "go" }] });
    expect(out.text).toBe("ok");
  });

  it("falls back from a transient error to the next provider", async () => {
    const events: string[] = [];
    const a = fixedProvider("a", new LlmProviderError({ provider: "a", kind: "server", message: "down", transient: true }));
    const b = fixedProvider("b", { text: "from b", thoughts: "", provider: "b", model: "bm" });
    const chain = new FallbackLlmProvider({
      providers: [a.provider, b.provider],
      onFallback: (event) => events.push(`${event.from}->${event.to}`),
    });
    const out = await chain.complete({ messages: [{ role: "user", content: "go" }] });
    expect(out.text).toBe("from b");
    expect(events).toEqual(["a->b"]);
  });

  it("does NOT fall back on a non-transient (auth) error", async () => {
    const events: string[] = [];
    const a = fixedProvider("a", new LlmProviderError({ provider: "a", kind: "auth", message: "bad key", transient: false }));
    const b = fixedProvider("b", { text: "from b", thoughts: "", provider: "b", model: "bm" });
    const chain = new FallbackLlmProvider({
      providers: [a.provider, b.provider],
      onFallback: (event) => events.push(`${event.from}->${event.to}`),
    });
    await expect(chain.complete({ messages: [{ role: "user", content: "go" }] })).rejects.toBeInstanceOf(
      LlmProviderError,
    );
    expect(events).toEqual([]);
  });

  it("throws AggregateLlmError when every provider fails transiently", async () => {
    const a = fixedProvider("a", new LlmProviderError({ provider: "a", kind: "server", message: "down", transient: true }));
    const b = fixedProvider("b", new LlmProviderError({ provider: "b", kind: "rate_limit", message: "429", transient: true }));
    const chain = new FallbackLlmProvider({ providers: [a.provider, b.provider] });
    await expect(chain.complete({ messages: [{ role: "user", content: "go" }] })).rejects.toBeInstanceOf(
      AggregateLlmError,
    );
    try {
      await chain.complete({ messages: [{ role: "user", content: "go" }] });
    } catch (err) {
      expect((err as AggregateLlmError).errors).toHaveLength(2);
      expect((err as AggregateLlmError).errors.map((e) => e.provider)).toEqual(["a", "b"]);
    }
  });

  it("throws when constructed with an empty provider list", () => {
    expect(() => new FallbackLlmProvider({ providers: [] })).toThrow();
  });

  it("reports providerIds in order", () => {
    const a = fixedProvider("a", { text: "x", thoughts: "", provider: "a", model: "am" });
    const b = fixedProvider("b", { text: "x", thoughts: "", provider: "b", model: "bm" });
    const chain = new FallbackLlmProvider({ providers: [a.provider, b.provider] });
    expect(chain.providerIds).toEqual(["a", "b"]);
  });
});
