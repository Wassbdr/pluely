import { GripVerticalIcon } from "lucide-react";
import { Button } from "@/components";

export const DragButton = () => {
  // Free drag: grab this handle to move the overlay anywhere.
  // `data-tauri-drag-region` makes the element a native window-drag zone.
  return (
    <Button
      variant="ghost"
      size="icon"
      className={`-ml-[2px] w-fit cursor-grab active:cursor-grabbing`}
      data-tauri-drag-region
      aria-label="Move Pluely (drag)"
    >
      <GripVerticalIcon className="h-4 w-4" data-tauri-drag-region />
    </Button>
  );
};
