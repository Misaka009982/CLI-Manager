import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
} from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "../lib/utils";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

interface PopoverContentProps
  extends ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> {
  portalContainer?: HTMLElement | null;
}

const PopoverContent = forwardRef<
  ElementRef<typeof PopoverPrimitive.Content>,
  PopoverContentProps
>(({ className, align = "start", sideOffset = 6, portalContainer, ...props }, ref) => (
  <PopoverPrimitive.Portal container={portalContainer ?? undefined}>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "ui-glass ui-bloom-shadow z-40 overflow-hidden rounded-xl outline-none",
        "data-[state=open]:animate-slide-down",
        className
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent };
