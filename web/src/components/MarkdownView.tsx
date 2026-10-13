import { useMemo, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline, type ListBlock } from "../markdown";

/**
 * Shows a note body with its formatting. Built from React elements only (no
 * HTML strings), so note text can't inject markup. When `onToggleTask` is
 * given, task boxes written in the body (`- [ ] …`) can be ticked in place.
 */
export function MarkdownView({
  source,
  className,
  onToggleTask,
  highlight,
}: {
  source: string;
  className?: string;
  onToggleTask?: (line: number) => void;
  /** Search words to highlight in the text. */
  highlight?: string;
}) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const hl = highlight?.trim().toLowerCase() || "";
  return (
    <div className={"md" + (className ? " " + className : "")}>
      {blocks.map((b, i) => renderBlock(b, i, onToggleTask, hl))}
    </div>
  );
}

function renderBlock(
  b: Block,
  key: number,
  onToggleTask: ((line: number) => void) | undefined,
  hl: string,
): ReactNode {
  switch (b.type) {
    case "heading": {
      const Tag = (`h${b.level + 2}` as "h3" | "h4" | "h5");
      return (
        <Tag key={key} className={`md-h md-h${b.level}`}>
          {renderInline(b.content, hl)}
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p key={key} className="md-p">
          {renderInline(b.content, hl)}
        </p>
      );
    case "quote":
      return (
        <blockquote key={key} className="md-quote">
          {renderInline(b.content, hl)}
        </blockquote>
      );
    case "code":
      return (
        <pre key={key} className="md-pre">
          <code>{b.text}</code>
        </pre>
      );
    case "hr":
      return <hr key={key} className="md-hr" />;
    case "list":
      return renderList(b, key, onToggleTask, hl);
  }
}

function renderList(
  list: ListBlock,
  key: number,
  onToggleTask: ((line: number) => void) | undefined,
  hl: string,
): ReactNode {
  const hasTasks = list.items.some((it) => it.task);
  const items = list.items.map((it) => (
    <li
      key={it.line}
      className={
        it.task ? "md-task" + (it.checked ? " done" : "") : undefined
      }
    >
      {it.task ? (
        <label className="md-task-label">
          <input
            type="checkbox"
            checked={it.checked}
            disabled={!onToggleTask}
            onChange={() => onToggleTask?.(it.line)}
            onClick={(e) => e.stopPropagation()}
          />
          <span>{renderInline(it.content, hl)}</span>
        </label>
      ) : (
        renderInline(it.content, hl)
      )}
      {it.children && renderList(it.children, 0, onToggleTask, hl)}
    </li>
  ));
  const cls = "md-list" + (hasTasks ? " md-has-tasks" : "");
  return list.ordered ? (
    <ol key={key} className={cls} start={list.start !== 1 ? list.start : undefined}>
      {items}
    </ol>
  ) : (
    <ul key={key} className={cls}>
      {items}
    </ul>
  );
}

function highlightText(text: string, hl: string, key: number): ReactNode {
  if (!hl) return text;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let at = lower.indexOf(hl);
  if (at < 0) return text;
  while (at >= 0) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <mark key={`${key}-${at}`} className="md-search-hit">
        {text.slice(at, at + hl.length)}
      </mark>,
    );
    from = at + hl.length;
    at = lower.indexOf(hl, from);
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

function renderInline(nodes: Inline[], hl: string): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.type) {
      case "text":
        return <span key={i}>{highlightText(n.text, hl, i)}</span>;
      case "code":
        return (
          <code key={i} className="md-code">
            {n.text}
          </code>
        );
      case "strong":
        return <strong key={i}>{renderInline(n.children, hl)}</strong>;
      case "em":
        return <em key={i}>{renderInline(n.children, hl)}</em>;
      case "del":
        return <del key={i}>{renderInline(n.children, hl)}</del>;
      case "mark":
        return (
          <mark key={i} className="md-mark">
            {renderInline(n.children, hl)}
          </mark>
        );
      case "link":
        return (
          <a
            key={i}
            href={n.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            {renderInline(n.children, hl)}
          </a>
        );
    }
  });
}
