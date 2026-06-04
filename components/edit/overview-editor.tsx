/**
 * The `overview` WYSIWYG editor (#356 Phase 6 C3) — Tiptap with an explicit
 * eight-tag schema (UI-SPEC § The overview editor).
 *
 * Schema: `p`, `br`, `strong`, `em`, `ul`, `ol`, `li`, `a`. Anything else
 * (headings, code, images, blockquote, etc.) is stripped at paste — the
 * StarterKit is deliberately not used. `@tiptap/extension-character-count` is
 * also not used: the parent measures `getHTML().length` against the 20,000-char
 * cap (self-edit-spec.md § overview), and the extension counts visible
 * characters — a different measure.
 *
 * The client schema is **not** a security boundary. The server sanitizer in
 * `lib/edit/validators.ts` is authoritative; this schema is a UX convenience.
 */
"use client";

import * as React from "react";
import Bold from "@tiptap/extension-bold";
import BulletList from "@tiptap/extension-bullet-list";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import History from "@tiptap/extension-history";
import Italic from "@tiptap/extension-italic";
import Link from "@tiptap/extension-link";
import ListItem from "@tiptap/extension-list-item";
import OrderedList from "@tiptap/extension-ordered-list";
import Paragraph from "@tiptap/extension-paragraph";
import Placeholder from "@tiptap/extension-placeholder";
import Text from "@tiptap/extension-text";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import {
  Bold as BoldIcon,
  Italic as ItalicIcon,
  Link as LinkIcon,
  List as ListIcon,
  ListOrdered as ListOrderedIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export type OverviewEditorProps = {
  /** The initial sanitized HTML to load into the editor. Empty string = blank document. */
  initialHtml: string;
  /** Fires on every content change with the serialized HTML — empty document serializes to `""`. */
  onChange: (html: string) => void;
};

/** Permitted URL schemes for `<a href>` — mirrors the server-side validators. */
const LINK_SCHEME_REGEX = /^(https?:|mailto:)/i;

/**
 * The WYSIWYG bio editor. A `'use client'` island — loaded only on `/edit/*`,
 * never in the public bundle.
 */
export function OverviewEditor({ initialHtml, onChange }: OverviewEditorProps) {
  const editor = useEditor({
    content: initialHtml,
    // Next 15 + React 19 SSR-hydration safety: defer the first render so the
    // server-rendered shell does not include the editor's client-only DOM.
    immediatelyRender: false,
    extensions: [
      Document,
      Paragraph,
      Text,
      Bold,
      Italic,
      BulletList,
      OrderedList,
      ListItem,
      HardBreak,
      Link.configure({
        openOnClick: false,
        protocols: ["https", "http", "mailto"],
        // Tiptap calls `validate` with each candidate href before applying it.
        // A rejected href becomes plain text; we still get a friendlier error
        // from the popover's own validation before this fires.
        validate: (href) => LINK_SCHEME_REGEX.test(href),
        HTMLAttributes: {
          rel: "noopener noreferrer nofollow",
          target: "_blank",
        },
      }),
      History,
      Placeholder.configure({
        placeholder:
          "Write a short bio — your background, research focus, and clinical interests.",
      }),
    ],
    editorProps: {
      attributes: {
        "aria-label": "Profile overview",
        role: "textbox",
        "aria-multiline": "true",
        class: cn(
          "min-h-[12rem] px-4 py-3 text-base leading-relaxed",
          "prose prose-sm max-w-none",
          "focus:outline-none",
        ),
      },
    },
    onUpdate({ editor }) {
      onChange(editor.isEmpty ? "" : editor.getHTML());
    },
  });

  return (
    <div className="bg-apollo-surface border-apollo-border-strong rounded-md border">
      <Toolbar editor={editor} />
      <Separator />
      <EditorContent editor={editor} data-slot="overview-editor" />
      <p className="text-muted-foreground px-4 pb-3 pt-2 text-sm">
        Formatting is limited to bold, italics, lists, and links.
      </p>
    </div>
  );
}

/** The single-row toolbar above the editor. */
function Toolbar({ editor }: { editor: Editor | null }) {
  const disabled = !editor;
  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex flex-wrap items-center gap-1 px-2 py-2"
    >
      <ToolbarButton
        label="Bold"
        active={editor?.isActive("bold") ?? false}
        disabled={disabled}
        onClick={() => editor?.chain().focus().toggleBold().run()}
      >
        <BoldIcon />
      </ToolbarButton>
      <ToolbarButton
        label="Italic"
        active={editor?.isActive("italic") ?? false}
        disabled={disabled}
        onClick={() => editor?.chain().focus().toggleItalic().run()}
      >
        <ItalicIcon />
      </ToolbarButton>
      <Separator orientation="vertical" className="mx-1 h-6" />
      <ToolbarButton
        label="Bullet list"
        active={editor?.isActive("bulletList") ?? false}
        disabled={disabled}
        onClick={() => editor?.chain().focus().toggleBulletList().run()}
      >
        <ListIcon />
      </ToolbarButton>
      <ToolbarButton
        label="Numbered list"
        active={editor?.isActive("orderedList") ?? false}
        disabled={disabled}
        onClick={() => editor?.chain().focus().toggleOrderedList().run()}
      >
        <ListOrderedIcon />
      </ToolbarButton>
      <Separator orientation="vertical" className="mx-1 h-6" />
      <LinkPopover editor={editor} />
    </div>
  );
}

type ToolbarButtonProps = {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
};

function ToolbarButton({ label, active, disabled, onClick, children }: ToolbarButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(active && "bg-accent text-accent-foreground")}
    >
      {children}
    </Button>
  );
}

/**
 * The Link popover. Opening it with text selected sets a new link; opening it
 * with the cursor inside an existing link pre-fills the URL and exposes Remove.
 */
function LinkPopover({ editor }: { editor: Editor | null }) {
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  // Pre-fill from the active mark when the popover opens.
  React.useEffect(() => {
    if (!open || !editor) return;
    const href = editor.getAttributes("link").href as string | undefined;
    setValue(href ?? "");
    setError(null);
  }, [open, editor]);

  const editingExisting = editor?.isActive("link") ?? false;

  function apply() {
    if (!editor) return;
    const trimmed = value.trim();
    if (trimmed === "") {
      setError("Enter a URL.");
      return;
    }
    if (!LINK_SCHEME_REGEX.test(trimmed)) {
      setError("Use https://, http://, or mailto: only.");
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: trimmed }).run();
    setOpen(false);
  }

  function remove() {
    editor?.chain().focus().extendMarkRange("link").unsetLink().run();
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={editingExisting ? "Edit link" : "Add link"}
          aria-pressed={editingExisting}
          disabled={!editor}
          className={cn(editingExisting && "bg-accent text-accent-foreground")}
        >
          <LinkIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="flex flex-col gap-2">
          <label htmlFor="overview-editor-link-url" className="text-sm font-medium">
            URL
          </label>
          <Input
            id="overview-editor-link-url"
            type="url"
            placeholder="https://example.com"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                apply();
              }
            }}
            aria-invalid={error !== null}
            aria-describedby={error ? "overview-editor-link-error" : undefined}
            autoFocus
          />
          {error && (
            <p id="overview-editor-link-error" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="mt-1 flex items-center justify-end gap-2">
            {editingExisting && (
              <Button type="button" variant="ghost" size="sm" onClick={remove}>
                Remove
              </Button>
            )}
            <Button type="button" size="sm" onClick={apply}>
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
