import { useCallback, useLayoutEffect, useRef, useState } from "react";

interface PreviewScrollOptions {
  open: boolean;
  sessionKey: string;
  selectedMessageIndex: number | null;
  content: string | null;
}

interface ScrollIntent {
  sessionKey: string;
  messageIndex: number;
  content?: string;
}

// 滚动意图绑定当前会话及回答；只有显式跳转才吸收同一正文的图片/异步渲染高度变化。
export function useMarkdownPreviewScroll({
  open,
  sessionKey,
  selectedMessageIndex,
  content,
}: PreviewScrollOptions) {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [requestVersion, setRequestVersion] = useState(0);
  const pendingJumpRef = useRef<ScrollIntent | null>(null);
  const bottomAnchorRef = useRef<ScrollIntent | null>(null);

  const cancelScrollIntent = useCallback(() => {
    pendingJumpRef.current = null;
    bottomAnchorRef.current = null;
  }, []);

  const syncScrollState = useCallback(() => {
    const canScroll = Boolean(open && content && scrollElement && scrollElement.clientHeight > 0
      && scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop > 2);
    setShowScrollToBottom((current) => current === canScroll ? current : canScroll);
  }, [content, open, scrollElement]);

  // 已选择最新回答时也产生新意图，确保重复点击仍能回到正文末尾。
  const requestScrollToBottom = useCallback((messageIndex: number) => {
    pendingJumpRef.current = { sessionKey, messageIndex };
    bottomAnchorRef.current = null;
    setRequestVersion((current) => current + 1);
  }, [sessionKey]);

  const scrollToBottom = useCallback(() => {
    if (selectedMessageIndex !== null) requestScrollToBottom(selectedMessageIndex);
  }, [requestScrollToBottom, selectedMessageIndex]);

  useLayoutEffect(() => {
    if (!open) {
      cancelScrollIntent();
      syncScrollState();
      return;
    }
    const anchor = bottomAnchorRef.current;
    if (anchor && (anchor.sessionKey !== sessionKey || anchor.messageIndex !== selectedMessageIndex
      || anchor.content !== content)) bottomAnchorRef.current = null;

    const pending = pendingJumpRef.current;
    if (pending && pending.sessionKey !== sessionKey) pendingJumpRef.current = null;
    if (scrollElement && content && pending?.sessionKey === sessionKey
      && pending.messageIndex === selectedMessageIndex) {
      bottomAnchorRef.current = { ...pending, content };
      pendingJumpRef.current = null;
      scrollElement.scrollTop = scrollElement.scrollHeight;
    }
    syncScrollState();
  }, [cancelScrollIntent, content, open, requestVersion, scrollElement, selectedMessageIndex, sessionKey, syncScrollState]);

  useLayoutEffect(() => {
    if (!open || !scrollElement) return;
    // 用户开始滚动即取消显式跳转的锚定；不会自动追随下一轮回答或刷新后的新正文。
    const handleScroll = () => {
      if (scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop > 2) {
        bottomAnchorRef.current = null;
      }
      syncScrollState();
    };
    const handleResize = () => {
      const anchor = bottomAnchorRef.current;
      if (anchor?.sessionKey === sessionKey && anchor.messageIndex === selectedMessageIndex
        && anchor.content === content) scrollElement.scrollTop = scrollElement.scrollHeight;
      syncScrollState();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
        cancelScrollIntent();
      }
    };
    const observer = new ResizeObserver(handleResize);
    observer.observe(scrollElement);
    if (contentElement) observer.observe(contentElement);
    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    scrollElement.addEventListener("wheel", cancelScrollIntent, { passive: true });
    scrollElement.addEventListener("pointerdown", cancelScrollIntent, { passive: true });
    scrollElement.addEventListener("keydown", handleKeyDown);
    syncScrollState();
    return () => {
      observer.disconnect();
      scrollElement.removeEventListener("scroll", handleScroll);
      scrollElement.removeEventListener("wheel", cancelScrollIntent);
      scrollElement.removeEventListener("pointerdown", cancelScrollIntent);
      scrollElement.removeEventListener("keydown", handleKeyDown);
    };
  }, [cancelScrollIntent, content, contentElement, open, scrollElement, selectedMessageIndex, sessionKey, syncScrollState]);

  return {
    scrollRef: setScrollElement,
    contentRef: setContentElement,
    showScrollToBottom,
    scrollToBottom,
    requestScrollToBottom,
    cancelScrollIntent,
  };
}
