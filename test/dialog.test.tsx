// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "../src/client/components/Dialog";

afterEach(cleanup);

describe("Dialog", () => {
  it("closes when its backdrop is clicked", () => {
    const close = vi.fn();
    const { container } = render(<Dialog title="Settings" onClose={close}><button>Inside</button></Dialog>);
    fireEvent.click(container.querySelector(".modal-backdrop")!);
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not close when content is clicked", () => {
    const close = vi.fn();
    render(<Dialog title="Settings" onClose={close}><button>Inside</button></Dialog>);
    fireEvent.click(screen.getByText("Inside"));
    expect(close).not.toHaveBeenCalled();
  });
});
