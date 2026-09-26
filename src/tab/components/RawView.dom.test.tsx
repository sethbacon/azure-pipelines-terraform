/**
 * @jest-environment jsdom
 */

import * as React from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { RawView, downloadRawContent } from "./RawView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OVERSIZED = "x".repeat(2 * 1024 * 1024 + 1);

interface AnchorClick {
  href: string | null;
  download: string;
  attached: boolean;
}

let container: HTMLDivElement;
let root: Root;
let createObjectURL: jest.Mock;
let revokeObjectURL: jest.Mock;
let anchorClicks: AnchorClick[];

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  // jsdom implements neither, so these stand in for the browser's.
  createObjectURL = jest.fn(() => "blob:mock-download");
  revokeObjectURL = jest.fn();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  // Records the temporary link instead of letting jsdom attempt a navigation.
  anchorClicks = [];
  jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    anchorClicks.push({ href: this.getAttribute("href"), download: this.download, attached: this.isConnected });
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("RawView download (live DOM)", () => {
  it("creates no object URL across re-renders of an oversized body", () => {
    for (let i = 0; i < 14; i++) {
      act(() => root.render(<RawView name={`plan-${i}`} content={OVERSIZED} format="text" />));
    }
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("on click, downloads the content as text/plain under the sanitized name, then revokes the URL", async () => {
    act(() => root.render(<RawView name="../prod plan" content={OVERSIZED} format="text" />));

    act(() => (container.querySelector(".plan-oversize button") as HTMLButtonElement).click());

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/plain");
    expect(await readBlob(blob)).toBe(OVERSIZED);
    expect(anchorClicks).toEqual([{ href: "blob:mock-download", download: ".._prod_plan.txt", attached: true }]);
    expect(document.querySelector("a")).toBeNull(); // the temporary link is gone again

    // Still live while the browser starts the download; revoked once the delay passes.
    jest.advanceTimersByTime(39 * 1000);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-download");
  });

  it("each click creates its own object URL", () => {
    act(() => root.render(<RawView name="plan" content={OVERSIZED} format="text" />));
    const button = container.querySelector(".plan-oversize button") as HTMLButtonElement;

    act(() => button.click());
    act(() => button.click());

    expect(createObjectURL).toHaveBeenCalledTimes(2);
    jest.runOnlyPendingTimers();
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("still removes the link and revokes the URL when the link click throws", () => {
    (HTMLAnchorElement.prototype.click as jest.Mock).mockImplementation(() => {
      throw new Error("download blocked");
    });

    expect(() => downloadRawContent("plan", "body")).toThrow("download blocked");

    expect(document.querySelector("a")).toBeNull();
    jest.runOnlyPendingTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-download");
  });
});
