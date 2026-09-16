import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { ArrowDownToLine, Check, ChevronDown } from "lucide-react";

export interface MarkdownPreviewMessage {
  messageIndex: number;
  order: number;
  content: string;
  timestamp: string | null;
}

interface MarkdownPreviewAnswerSelectProps {
  messages: readonly MarkdownPreviewMessage[];
  selectedMessageIndex: number | null;
  onSelect: (messageIndex: number) => void;
  formatOption: (message: MarkdownPreviewMessage) => string;
  ariaLabel: string;
  title: string;
  jumpToEndLabel: string;
  terminalPreviewStyle: CSSProperties;
}

interface ScrollbarProps {
  viewport: HTMLDivElement | null;
  content: HTMLDivElement | null;
}

// Radix 隐藏原生滑块；覆盖层只映射同一个 Viewport，不创建第二个滚动源。
function AnswerScrollbar({ viewport, content }: ScrollbarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startY: number; startScrollTop: number } | null>(null);
  const thumbHeightRef = useRef(0);
  const [visible, setVisible] = useState(false);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!viewport || !track || !thumb) return;
    // 直接更新滑块样式，滚轮滚动不会让完整回答列表重新渲染。
    const sync = () => {
      const range = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const trackHeight = track.clientHeight;
      const overflowing = range > 1 && viewport.clientHeight > 0 && trackHeight > 0;
      const height = overflowing
        ? Math.min(trackHeight, Math.max(24, trackHeight * viewport.clientHeight / viewport.scrollHeight)) : 0;
      const top = overflowing ? Math.max(0, Math.min(1, viewport.scrollTop / range)) * (trackHeight - height) : 0;
      thumbHeightRef.current = height;
      thumb.style.height = `${height}px`;
      thumb.style.transform = `translateY(${top}px)`;
      setVisible((current) => current === overflowing ? current : overflowing);
    };
    const observer = new ResizeObserver(sync);
    observer.observe(viewport);
    observer.observe(track);
    if (content) observer.observe(content);
    viewport.addEventListener("scroll", sync, { passive: true });
    sync();
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", sync);
      dragRef.current = null;
    };
  }, [content, viewport]);

  // 同一 pointer 捕获完整拖动周期；位移按轨道/正文范围换算，取消或失去捕获时释放状态。
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !viewport || !visible) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startScrollTop: viewport.scrollTop };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const track = trackRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !viewport || !track) return;
    event.preventDefault();
    event.stopPropagation();
    const range = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const travel = Math.max(1, track.clientHeight - thumbHeightRef.current);
    viewport.scrollTop = Math.max(0, Math.min(range, drag.startScrollTop + (event.clientY - drag.startY) * range / travel));
  };
  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      ref={trackRef}
      className="ui-subagent-scrollbar terminal-markdown-preview-answer-scrollbar"
      data-visible={visible ? "true" : "false"}
      data-dragging={dragging ? "true" : "false"}
      style={{ visibility: visible ? "visible" : "hidden" }}
      aria-hidden="true"
    >
      <div
        ref={thumbRef}
        className="ui-subagent-scrollbar-thumb"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
      />
    </div>
  );
}

export function MarkdownPreviewAnswerSelect({
  messages,
  selectedMessageIndex,
  onSelect,
  formatOption,
  ariaLabel,
  title,
  jumpToEndLabel,
  terminalPreviewStyle,
}: MarkdownPreviewAnswerSelectProps) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [listContent, setListContent] = useState<HTMLDivElement | null>(null);
  const jumpButtonRef = useRef<HTMLButtonElement>(null);
  const lastFocusedOptionRef = useRef<HTMLElement | null>(null);
  const selectedValue = selectedMessageIndex ?? messages[0]?.messageIndex;

  // 固定操作只滚动列表。选择仍由 Radix Item 完成，菜单不关闭、不更改回答。
  const jumpToListEnd = () => {
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  };
  // Select 默认拦截 Tab；显式在回答选项和固定操作之间切换，保留方向键/Enter/Escape。
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      event.preventDefault();
      if (event.target === jumpButtonRef.current) {
        const previous = lastFocusedOptionRef.current;
        const option = previous && viewport?.contains(previous) ? previous
          : viewport?.querySelector<HTMLElement>('[role="option"][data-state="checked"]');
        option?.focus({ preventScroll: true });
        option?.scrollIntoView({ block: "nearest" });
      } else {
        if (event.target instanceof HTMLElement && event.target.getAttribute("role") === "option") {
          lastFocusedOptionRef.current = event.target;
        }
        jumpButtonRef.current?.focus({ preventScroll: true });
      }
    }
  };

  if (selectedValue == null) return null;

  return (
    <SelectPrimitive.Root value={String(selectedValue)} onValueChange={(value) => onSelect(Number(value))}>
      <SelectPrimitive.Trigger
        className="terminal-markdown-preview-message-select ui-focus-ring inline-flex min-w-0 max-w-[48%] items-center justify-between gap-1 rounded-md px-1.5 py-1 text-[10px] outline-none"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        title={title}
      >
        <span className="min-w-0 flex-1 truncate text-left"><SelectPrimitive.Value /></span>
        <SelectPrimitive.Icon asChild>
          <ChevronDown size={11} className="shrink-0 opacity-70" aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          align="end"
          sideOffset={4}
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          onKeyDown={handleKeyDown}
          className="terminal-markdown-preview-answer-popover z-[1000] overflow-hidden rounded-md border py-1 text-[10px] shadow-lg"
          style={{
            ...terminalPreviewStyle,
            width: "max(150px, var(--radix-select-trigger-width))",
            maxWidth: "var(--radix-select-content-available-width)",
            maxHeight: "min(228px, var(--radix-select-content-available-height))",
          }}
        >
          <div className="relative min-h-0 overflow-hidden">
            <SelectPrimitive.Viewport
              ref={setViewport}
              role="listbox"
              aria-label={ariaLabel}
              className="ui-thin-scroll terminal-markdown-preview-answer-viewport overflow-y-auto p-0"
              style={{ maxHeight: "min(188px, calc(var(--radix-select-content-available-height) - 40px))" }}
            >
              <div ref={setListContent}>
                {messages.map((message) => (
                  <SelectPrimitive.Item
                    key={message.messageIndex}
                    value={String(message.messageIndex)}
                    className="terminal-markdown-preview-answer-option relative flex cursor-pointer items-center gap-2 outline-none"
                  >
                    <SelectPrimitive.ItemText asChild>
                      <span className="min-w-0 flex-1 truncate">{formatOption(message)}</span>
                    </SelectPrimitive.ItemText>
                    <SelectPrimitive.ItemIndicator asChild><Check size={11} className="shrink-0" aria-hidden="true" /></SelectPrimitive.ItemIndicator>
                  </SelectPrimitive.Item>
                ))}
              </div>
            </SelectPrimitive.Viewport>
            <AnswerScrollbar viewport={viewport} content={listContent} />
          </div>
          <button
            ref={jumpButtonRef}
            type="button"
            onClick={jumpToListEnd}
            onKeyDown={(event) => {
              // 在事件到达 Select 前隔离空格/Enter，保留原生 button 的键盘点击。
              if (event.key === " " || event.key === "Enter") event.stopPropagation();
            }}
            className="terminal-markdown-preview-answer-end ui-focus-ring mx-1 mt-1 inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded px-1.5"
            title={jumpToEndLabel}
            aria-label={jumpToEndLabel}
          >
            <ArrowDownToLine size={12} className="shrink-0" aria-hidden="true" />
            <span className="truncate">{jumpToEndLabel}</span>
          </button>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
