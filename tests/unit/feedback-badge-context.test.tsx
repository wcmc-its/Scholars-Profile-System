/**
 * `FeedbackBadgeProvider` + suppression hooks (#538) — verifies the
 * refcount semantics: zero consumers → not suppressed; one consumer
 * mounted → suppressed; two consumers stacked → still suppressed
 * after one unmounts; both unmount → not suppressed; and the hooks
 * no-op when used outside the provider so a Dialog rendered in a
 * test doesn't blow up.
 */
import { describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";

import {
  FeedbackBadgeProvider,
  useFeedbackBadgeSuppressed,
  useSuppressFeedbackBadgeWhileMounted,
} from "@/components/site/feedback-badge-context";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

/** Test helper: renders its suppression status into a `data-` attribute
 *  so the assertion side reads the DOM, not a hook. */
function StatusProbe() {
  const suppressed = useFeedbackBadgeSuppressed();
  return <div data-testid="probe" data-suppressed={suppressed ? "true" : "false"} />;
}

function Consumer() {
  useSuppressFeedbackBadgeWhileMounted();
  return null;
}

describe("FeedbackBadgeProvider — suppression count", () => {
  it("reports false when zero consumers are mounted", () => {
    const { getByTestId } = render(
      <FeedbackBadgeProvider>
        <StatusProbe />
      </FeedbackBadgeProvider>,
    );
    expect(getByTestId("probe").dataset.suppressed).toBe("false");
  });

  it("reports true when one consumer mounts", () => {
    const { getByTestId } = render(
      <FeedbackBadgeProvider>
        <StatusProbe />
        <Consumer />
      </FeedbackBadgeProvider>,
    );
    expect(getByTestId("probe").dataset.suppressed).toBe("true");
  });

  it("stacks: stays suppressed while at least one consumer is mounted", () => {
    function Stacked({ showSecond }: { showSecond: boolean }) {
      return (
        <FeedbackBadgeProvider>
          <StatusProbe />
          <Consumer />
          {showSecond ? <Consumer /> : null}
        </FeedbackBadgeProvider>
      );
    }
    const { getByTestId, rerender } = render(<Stacked showSecond={true} />);
    expect(getByTestId("probe").dataset.suppressed).toBe("true");
    // Unmount the second consumer; first is still up.
    rerender(<Stacked showSecond={false} />);
    expect(getByTestId("probe").dataset.suppressed).toBe("true");
  });

  it("returns to false when every consumer unmounts", () => {
    function Toggleable({ showConsumer }: { showConsumer: boolean }) {
      return (
        <FeedbackBadgeProvider>
          <StatusProbe />
          {showConsumer ? <Consumer /> : null}
        </FeedbackBadgeProvider>
      );
    }
    const { getByTestId, rerender } = render(<Toggleable showConsumer={true} />);
    expect(getByTestId("probe").dataset.suppressed).toBe("true");
    act(() => {
      rerender(<Toggleable showConsumer={false} />);
    });
    expect(getByTestId("probe").dataset.suppressed).toBe("false");
  });
});

describe("hooks outside the provider", () => {
  it("useFeedbackBadgeSuppressed returns false (safe default)", () => {
    const { getByTestId } = render(<StatusProbe />);
    expect(getByTestId("probe").dataset.suppressed).toBe("false");
  });

  it("useSuppressFeedbackBadgeWhileMounted is a no-op without provider", () => {
    // No throw, no infinite render, no console errors. The assertion is
    // that render() returns successfully.
    expect(() => render(<Consumer />)).not.toThrow();
  });
});

// Regression: a CLOSED dialog/sheet (e.g. the header's MobileNav sheet, on every
// page) must not suppress the badge. The hook used to run in the Content
// wrapper, which renders even while closed.
describe("Dialog / Sheet — suppress only while open", () => {
  it("closed dialog and sheet do not suppress; open dialog does", () => {
    function Tree({ open }: { open: boolean }) {
      return (
        <FeedbackBadgeProvider>
          <StatusProbe />
          <Sheet open={false}>
            <SheetContent aria-describedby={undefined}>
              <SheetTitle>Menu</SheetTitle>
            </SheetContent>
          </Sheet>
          <Dialog open={open}>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>Hi</DialogTitle>
            </DialogContent>
          </Dialog>
        </FeedbackBadgeProvider>
      );
    }
    const { getByTestId, rerender } = render(<Tree open={false} />);
    expect(getByTestId("probe").dataset.suppressed).toBe("false");
    rerender(<Tree open={true} />);
    expect(getByTestId("probe").dataset.suppressed).toBe("true");
  });
});
