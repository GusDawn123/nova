/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextDocItem } from "@nova/shared";

import { KnowledgeTab } from "./knowledge";

function doc(overrides: Partial<ContextDocItem>): ContextDocItem {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    title: "Pricing playbook",
    chars: 12_400,
    created_at: "2026-08-20T12:00:00.000Z",
    indexed: true,
    ...overrides,
  };
}

interface BridgeStubs {
  listContextDocs: ReturnType<typeof vi.fn>;
  createContextDoc: ReturnType<typeof vi.fn>;
  deleteContextDoc: ReturnType<typeof vi.fn>;
}

function installBridge(overrides: Partial<BridgeStubs> = {}): BridgeStubs {
  const stubs: BridgeStubs = {
    listContextDocs: vi
      .fn()
      .mockResolvedValue({ ok: true, data: { docs: [doc({})] } }),
    createContextDoc: vi.fn().mockResolvedValue({
      ok: true,
      data: { doc: doc({ title: "New doc", indexed: false }), note: null },
    }),
    deleteContextDoc: vi
      .fn()
      .mockResolvedValue({ ok: true, data: { status: "deleted" } }),
    ...overrides,
  };
  Object.defineProperty(window, "novaBridge", {
    value: stubs,
    configurable: true,
  });
  return stubs;
}

afterEach(cleanup);

describe("KnowledgeTab", () => {
  it("lists the documents with their searchability said out loud", async () => {
    installBridge({
      listContextDocs: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          docs: [doc({}), doc({ id: "7".repeat(8), title: "Draft", indexed: false })],
        },
      }),
    });
    render(<KnowledgeTab />);

    expect(await screen.findByText("Pricing playbook")).toBeTruthy();
    expect(screen.getByText(/12\.4k chars · SEARCHABLE/)).toBeTruthy();
    expect(screen.getByText(/NOT INDEXED YET/)).toBeTruthy();
  });

  it("uploads title + text through the bridge and reloads the list", async () => {
    const stubs = installBridge();
    render(<KnowledgeTab />);
    await screen.findByText("Pricing playbook");

    fireEvent.change(screen.getByPlaceholderText("Document title"), {
      target: { value: "Objection handling" },
    });
    fireEvent.change(
      screen.getByPlaceholderText(/Paste text here/),
      { target: { value: "Feel, felt, found." } },
    );
    fireEvent.click(screen.getByText("Add to knowledge base"));

    await waitFor(() => {
      expect(stubs.createContextDoc).toHaveBeenCalledWith(
        "Objection handling",
        "Feel, felt, found.",
      );
    });
    // one load on mount, one after the upload
    expect(stubs.listContextDocs).toHaveBeenCalledTimes(2);
  });

  it("an empty composer is refused in words, never sent", async () => {
    const stubs = installBridge();
    render(<KnowledgeTab />);
    await screen.findByText("Pricing playbook");

    fireEvent.click(screen.getByText("Add to knowledge base"));

    expect(
      await screen.findByText(/needs both a title and some text/),
    ).toBeTruthy();
    expect(stubs.createContextDoc).not.toHaveBeenCalled();
  });

  it("delete asks the bridge for that document and reloads", async () => {
    const stubs = installBridge();
    render(<KnowledgeTab />);
    await screen.findByText("Pricing playbook");

    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => {
      expect(stubs.deleteContextDoc).toHaveBeenCalledWith(
        "66666666-6666-4666-8666-666666666666",
      );
    });
  });
});
