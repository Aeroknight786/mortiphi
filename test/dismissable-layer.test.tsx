// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { afterEach, describe, expect, it } from "vitest";
import { useDismissableLayer } from "../src/client/hooks/useDismissableLayer";

afterEach(cleanup);

function Fixture() {
  const [open, setOpen] = useState(false);
  const ref = useDismissableLayer<HTMLDivElement>(open, () => setOpen(false));
  return <><div ref={ref}><button onClick={() => setOpen(!open)}>Menu</button>{open && <button>Menu item</button>}</div><button>Outside</button></>;
}

describe("useDismissableLayer", () => {
  it("closes on an outside pointer interaction", () => {
    render(<Fixture/>);
    fireEvent.click(screen.getByText("Menu"));
    expect(screen.getByText("Menu item")).toBeTruthy();
    fireEvent.pointerDown(screen.getByText("Outside"));
    expect(screen.queryByText("Menu item")).toBeNull();
  });

  it("stays open for inside interactions and closes with Escape", () => {
    render(<Fixture/>);
    fireEvent.click(screen.getByText("Menu"));
    fireEvent.pointerDown(screen.getByText("Menu item"));
    expect(screen.getByText("Menu item")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Menu item")).toBeNull();
  });
});
