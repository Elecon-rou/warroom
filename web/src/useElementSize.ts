import { useLayoutEffect, useRef, useState } from 'react';
/** Observe the actual canvas, including space taken by the widget inspector. */
export function useElementSize(initialWidth = 960) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initialWidth);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (value: number) => {
      if (value > 0) setWidth(Math.round(value));
    };
    update(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => update(entries[0].contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}
