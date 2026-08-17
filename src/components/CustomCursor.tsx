import { useEffect, useRef } from "react";
import { MousePointer2 } from "lucide-react";

export const CustomCursor = () => {
  const cursorRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef({ x: 0, y: 0 });
  const isVisibleRef = useRef(false);

  useEffect(() => {
    let rafId: number;

    const updateCursorPosition = () => {
      if (cursorRef.current && isVisibleRef.current) {
        cursorRef.current.style.transform = `translate3d(${positionRef.current.x}px, ${positionRef.current.y}px, 0)`;
      }
      rafId = requestAnimationFrame(updateCursorPosition);
    };

    const show = (x: number, y: number) => {
      positionRef.current = { x, y };
      if (isVisibleRef.current) return;
      isVisibleRef.current = true;
      if (cursorRef.current) {
        // Move before revealing, so it never flashes at a stale position.
        cursorRef.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        cursorRef.current.style.opacity = "1";
      }
    };

    const hide = () => {
      isVisibleRef.current = false;
      if (cursorRef.current) {
        cursorRef.current.style.opacity = "0";
      }
    };

    const handleMove = (e: MouseEvent | PointerEvent) => {
      show(e.clientX, e.clientY);
    };

    // The real cursor is hidden by CSS the moment the pointer crosses into the
    // window, so waiting for a move event would leave no pointer at all.
    // Revealing on entry closes that gap — and pointer events reach an
    // unfocused overlay (focus: false) more reliably than legacy mouse ones.
    const handleEnter = (e: PointerEvent) => {
      show(e.clientX, e.clientY);
    };

    // Start the animation loop
    rafId = requestAnimationFrame(updateCursorPosition);

    // Add event listeners
    document.addEventListener("pointerover", handleEnter, { passive: true });
    document.addEventListener("pointermove", handleMove, { passive: true });
    document.addEventListener("mousemove", handleMove, { passive: true });
    document.addEventListener("pointerleave", hide);
    document.addEventListener("mouseleave", hide);
    window.addEventListener("blur", hide);

    return () => {
      document.removeEventListener("pointerover", handleEnter);
      document.removeEventListener("pointermove", handleMove);
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("pointerleave", hide);
      document.removeEventListener("mouseleave", hide);
      window.removeEventListener("blur", hide);
      cancelAnimationFrame(rafId);
    };
  }, []);

  return (
    <div
      ref={cursorRef}
      className="fixed top-0 left-0 pointer-events-none z-[9999] opacity-0 will-change-transform"
      style={{
        transform: "translate3d(0px, 0px, 0)",
        transition: "opacity 0.1s ease-out",
      }}
    >
      <MousePointer2 className="w-5 h-5 drop-shadow-2xl fill-secondary stroke-primary" />
    </div>
  );
};
