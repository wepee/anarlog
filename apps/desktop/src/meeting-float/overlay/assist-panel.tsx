import { type ReactNode, useEffect, useState } from "react";

import { CaretDown, X } from "@anlg/ui/components/icons";
import { cn } from "@anlg/utils";

import type { FloatingAssist, FloatingAssistAction } from "../assist";

type Tab = "questions" | "answers" | "todo" | "summary" | "live";

// The Live Assist panel of the webview overlay (Windows, Linux). macOS draws
// the same content natively in FloatingBarView.swift.
export function AssistPanel({
  assist,
  dark,
  live,
  onAction,
}: {
  assist: FloatingAssist;
  dark: boolean;
  live: ReactNode;
  onAction: (action: FloatingAssistAction) => void;
}) {
  const [tab, setTab] = useState<Tab>("questions");
  const [menu, setMenu] = useState<"template" | "project" | null>(null);
  const { labels } = assist;
  const muted = dark ? "rgba(255, 255, 255, 0.66)" : "rgba(31, 28, 26, 0.6)";
  const hairline = dark
    ? "rgba(255, 255, 255, 0.16)"
    : "rgba(31, 28, 26, 0.12)";

  useEffect(() => {
    if (tab === "questions" && assist.newQuestions > 0) {
      onAction({ action: "seenQuestions" });
    }
  }, [tab, assist.newQuestions, onAction]);

  useEffect(() => {
    if (tab === "answers" && assist.newAnswers > 0) {
      onAction({ action: "seenAnswers" });
    }
  }, [tab, assist.newAnswers, onAction]);

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "questions", label: labels.questions, count: assist.newQuestions },
    { id: "answers", label: labels.answers, count: assist.newAnswers },
    { id: "todo", label: labels.todo },
    { id: "summary", label: labels.summary },
    { id: "live", label: labels.live },
  ];

  return (
    <div
      className="relative flex h-full flex-col"
      data-tauri-drag-region="false"
    >
      <div className="flex flex-col gap-2 px-3 pt-3 pb-2">
        <div className="flex items-center justify-end gap-1.5">
          {assist.notice ? (
            <p
              className="mr-auto truncate text-[11.5px]"
              style={{ color: "rgb(255, 160, 140)" }}
              title={assist.notice}
            >
              {assist.notice}
            </p>
          ) : null}
          {assist.project ? (
            <MenuChip
              title={assist.project.title}
              auto={assist.project.auto ? labels.auto : null}
              open={menu === "project"}
              dark={dark}
              muted={muted}
              onClick={() =>
                setMenu((open) => (open === "project" ? null : "project"))
              }
            />
          ) : null}
          <MenuChip
            title={assist.template.title}
            auto={assist.template.auto ? labels.auto : null}
            open={menu === "template"}
            dark={dark}
            muted={muted}
            onClick={() =>
              setMenu((open) => (open === "template" ? null : "template"))
            }
          />
        </div>
        <div
          role="tablist"
          className="flex rounded-full p-[3px]"
          style={{
            background: dark ? "rgba(0,0,0,0.18)" : "rgba(31,28,26,0.07)",
          }}
        >
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className="flex flex-1 items-center justify-center gap-1 rounded-full py-1.5 text-[12.5px] font-medium transition-colors"
              style={{
                color: tab === item.id ? undefined : muted,
                background:
                  tab === item.id
                    ? dark
                      ? "linear-gradient(180deg, rgba(255,255,255,0.3), rgba(255,255,255,0.12))"
                      : "rgba(255,255,255,0.85)"
                    : "transparent",
                boxShadow:
                  tab === item.id
                    ? "inset 0 1px 0 rgba(255,255,255,0.55), 0 2px 8px rgba(0,0,0,0.18)"
                    : undefined,
              }}
            >
              {item.label}
              {item.count ? (
                <span className="font-mono text-[10.5px] opacity-75">
                  {item.count}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {tab === "questions" && (
          <QuestionsTab
            assist={assist}
            muted={muted}
            hairline={hairline}
            onAction={onAction}
            onOpenAnswers={() => setTab("answers")}
          />
        )}
        {tab === "answers" && (
          <AnswersTab
            assist={assist}
            muted={muted}
            hairline={hairline}
            dark={dark}
            onAction={onAction}
          />
        )}
        {tab === "todo" && <TodoTab assist={assist} muted={muted} />}
        {tab === "summary" && (
          <SummaryTab assist={assist} muted={muted} dark={dark} />
        )}
        {tab === "live" && <div className="-mx-4 h-full">{live}</div>}
      </div>

      {menu === "template" ? (
        <Menu
          label={labels.templateMenu}
          footer={labels.templateFooter}
          dark={dark}
          muted={muted}
          hairline={hairline}
          options={assist.templates.map((option) => ({
            key: option.id ?? "auto",
            title: option.title,
            selected: option.id === assist.template.id,
            onSelect: () =>
              onAction({ action: "selectTemplate", id: option.id }),
          }))}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {menu === "project" ? (
        <Menu
          label={labels.projectMenu}
          footer={labels.projectFooter}
          dark={dark}
          muted={muted}
          hairline={hairline}
          options={assist.projectOptions.map((option) => ({
            key: `${option.action}:${option.id ?? ""}`,
            title: option.title,
            selected: option.selected,
            onSelect: () =>
              onAction(
                option.action === "autoProject"
                  ? { action: "autoProject" }
                  : { action: "selectProject", id: option.id },
              ),
          }))}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}

function MenuChip({
  title,
  auto,
  open,
  dark,
  muted,
  onClick,
}: {
  title: string;
  auto: string | null;
  open: boolean;
  dark: boolean;
  muted: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={onClick}
      className="flex max-w-40 items-center gap-1 rounded-full px-2.5 py-0.5 text-[11.5px] font-medium"
      style={{
        background: dark ? "rgba(255,255,255,0.13)" : "rgba(31,28,26,0.08)",
      }}
    >
      <span className="truncate">{title}</span>
      {auto ? (
        <span className="shrink-0" style={{ color: muted }}>
          · {auto}
        </span>
      ) : null}
      <CaretDown size={9} weight="bold" className="shrink-0" />
    </button>
  );
}

function Menu({
  label,
  footer,
  options,
  dark,
  muted,
  hairline,
  onClose,
}: {
  label: string;
  footer: string;
  options: Array<{
    key: string;
    title: string;
    selected: boolean;
    onSelect: () => void;
  }>;
  dark: boolean;
  muted: string;
  hairline: string;
  onClose: () => void;
}) {
  return (
    <div
      role="menu"
      aria-label={label}
      className="absolute top-10 right-3 z-10 flex max-h-[70%] w-56 flex-col gap-px overflow-y-auto rounded-2xl p-1.5"
      style={{
        background: dark
          ? "rgba(40, 42, 37, 0.94)"
          : "rgba(246, 245, 240, 0.97)",
        boxShadow: `inset 0 0 0 0.5px ${hairline}, 0 12px 32px rgba(0,0,0,0.3)`,
      }}
    >
      <p
        className="px-2.5 pt-1.5 pb-1 font-mono text-[10.5px] tracking-wider uppercase"
        style={{ color: muted }}
      >
        {label}
      </p>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          role="menuitemradio"
          aria-checked={option.selected}
          onClick={() => {
            onClose();
            option.onSelect();
          }}
          className={cn([
            "rounded-xl px-2.5 py-1.5 text-left text-[13px]",
            option.selected ? "font-semibold" : "font-medium",
          ])}
          style={{
            background: option.selected
              ? dark
                ? "rgba(255,255,255,0.12)"
                : "rgba(31,28,26,0.06)"
              : undefined,
          }}
        >
          {option.title}
        </button>
      ))}
      <p
        className="mt-1 px-2.5 pt-1.5 pb-1 text-[11.5px]"
        style={{ color: muted, borderTop: `0.5px solid ${hairline}` }}
      >
        {footer}
      </p>
    </div>
  );
}

function AnswersTab({
  assist,
  muted,
  hairline,
  dark,
  onAction,
}: {
  assist: FloatingAssist;
  muted: string;
  hairline: string;
  dark: boolean;
  onAction: (action: FloatingAssistAction) => void;
}) {
  const [draft, setDraft] = useState("");
  const { labels } = assist;

  return (
    <div className="flex flex-col gap-3 pt-1">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const question = draft.trim();
          if (!question) return;
          onAction({ action: "ask", id: question });
          setDraft("");
        }}
      >
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={labels.askPlaceholder}
          aria-label={labels.askPlaceholder}
          className="w-full rounded-full px-3.5 py-2 text-[13px] outline-none"
          style={{
            background: dark ? "rgba(0,0,0,0.22)" : "rgba(255,255,255,0.7)",
            boxShadow: `inset 0 0 0 0.5px ${hairline}`,
          }}
        />
      </form>
      {assist.answers.length === 0 ? (
        <p className="text-[13px]" style={{ color: muted }}>
          {labels.emptyAnswers}
        </p>
      ) : (
        <ul className="flex flex-col">
          {assist.answers.map((answer, index) => (
            <li
              key={answer.id}
              className="flex flex-col gap-1 py-2.5"
              style={{
                borderTop: index === 0 ? undefined : `0.5px solid ${hairline}`,
              }}
            >
              <p className="text-[12px] leading-[1.4]" style={{ color: muted }}>
                {answer.isNew ? (
                  <span
                    aria-hidden
                    className="mr-1.5 inline-block size-[7px] rounded-full align-[1px]"
                    style={{ background: "rgb(255, 210, 122)" }}
                  />
                ) : null}
                {answer.origin === "asked" ? `${labels.youAsked} · ` : ""}
                {answer.question}
              </p>
              <p className="text-[14px] leading-[1.42] font-medium">
                {answer.status === "ready" || answer.answer
                  ? answer.answer
                  : answer.status === "error"
                    ? labels.noAnswer
                    : labels.answering}
              </p>
              {answer.sources.length > 0 ? (
                <p
                  className="font-mono text-[11px]"
                  style={{ color: "rgb(168, 212, 255)" }}
                >
                  {answer.sources
                    .map((source) =>
                      source.kind === "web"
                        ? `↗ ${source.label}`
                        : `◆ ${source.label}`,
                    )
                    .join("  ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SectionTitle({
  children,
  muted,
}: {
  children: ReactNode;
  muted: string;
}) {
  return (
    <p
      className="mt-3 mb-1.5 font-mono text-[10.5px] font-semibold tracking-wider uppercase first:mt-1"
      style={{ color: muted }}
    >
      {children}
    </p>
  );
}

function QuestionsTab({
  assist,
  muted,
  hairline,
  onAction,
  onOpenAnswers,
}: {
  assist: FloatingAssist;
  muted: string;
  hairline: string;
  onAction: (action: FloatingAssistAction) => void;
  onOpenAnswers: () => void;
}) {
  const statusDot = {
    covered: { background: "rgb(139, 224, 171)" },
    partial: {
      background:
        "linear-gradient(90deg, rgb(255, 210, 122) 50%, transparent 50%)",
      boxShadow: "inset 0 0 0 1.5px rgb(255, 210, 122)",
    },
    missing: { boxShadow: `inset 0 0 0 1.5px ${muted}` },
  } as const;

  return (
    <div>
      {assist.spotlight ? (
        <button
          type="button"
          onClick={onOpenAnswers}
          className="mt-1 mb-2 flex w-full flex-col gap-1 rounded-xl px-3 py-2 text-left"
          style={{ boxShadow: `inset 0 0 0 0.5px ${hairline}` }}
        >
          <span
            className="font-mono text-[10.5px] tracking-wider uppercase"
            style={{ color: "rgb(255, 210, 122)" }}
          >
            {assist.labels.suggestedAnswer}
          </span>
          <span className="text-[12px]" style={{ color: muted }}>
            {assist.spotlight.question}
          </span>
          <span className="text-[13.5px] leading-[1.4] font-medium">
            {assist.spotlight.answer}
          </span>
        </button>
      ) : null}
      {assist.questions.length === 0 ? (
        <p className="py-2 text-[13px]" style={{ color: muted }}>
          {assist.labels.emptyQuestions}
        </p>
      ) : (
        <ul className="flex flex-col">
          {assist.questions.map((question, index) => (
            <li
              key={question.id}
              className="group relative flex flex-col gap-1 py-2.5 pr-7"
              style={{
                borderTop: index === 0 ? undefined : `0.5px solid ${hairline}`,
              }}
            >
              <p className="text-[14.5px] leading-[1.38] font-medium">
                {question.isNew ? (
                  <span
                    aria-hidden
                    className="mr-1.5 inline-block size-[7px] rounded-full align-[2px]"
                    style={{ background: "rgb(255, 210, 122)" }}
                  />
                ) : null}
                {question.text}
              </p>
              {question.why ? (
                <p
                  className="text-[12.5px] leading-[1.42]"
                  style={{ color: muted }}
                >
                  {question.why}
                </p>
              ) : null}
              <button
                type="button"
                aria-label={assist.labels.dismiss}
                onClick={() =>
                  onAction({ action: "dismissQuestion", id: question.id })
                }
                className="absolute top-2 right-0 flex size-6 items-center justify-center rounded-full opacity-50 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              >
                <X size={10} weight="bold" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {assist.coverage.length > 0 ? (
        <>
          <SectionTitle muted={muted}>
            {assist.labels.toCover} · {assist.template.title}
          </SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {assist.coverage.map((point) => (
              <span
                key={point.label}
                title={point.evidence ?? undefined}
                className="inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2.5 pl-2 text-[12px]"
                style={{ background: "rgba(255,255,255,0.1)" }}
              >
                <span
                  aria-hidden
                  className="inline-block size-[9px] rounded-full"
                  style={statusDot[point.status]}
                />
                {point.label}
              </span>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function TodoTab({ assist, muted }: { assist: FloatingAssist; muted: string }) {
  if (assist.todoGroups.length === 0) {
    return (
      <p className="py-2 text-[13px]" style={{ color: muted }}>
        {assist.labels.emptyTodo}
      </p>
    );
  }
  return (
    <div>
      {assist.todoGroups.map((group) => (
        <div key={group.owner}>
          <SectionTitle muted={muted}>{group.owner}</SectionTitle>
          <ul className="flex flex-col gap-2">
            {group.items.map((item, index) => (
              <li
                key={`${item.text}-${index}`}
                className="flex flex-col gap-0.5 text-[13.5px] leading-[1.4]"
              >
                <span>{item.text}</span>
                {item.due || item.needsDetail ? (
                  <span
                    className="flex items-center gap-2 font-mono text-[11px]"
                    style={{ color: muted }}
                  >
                    {item.due ? `${assist.labels.due} ${item.due}` : null}
                    {item.needsDetail ? (
                      <span
                        className="rounded-full px-1.5 font-sans text-[10.5px] font-medium"
                        style={{
                          background: "rgba(255,210,122,0.2)",
                          color: "rgb(255, 210, 122)",
                        }}
                      >
                        {assist.labels.toClarify}
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function SummaryTab({
  assist,
  muted,
  dark,
}: {
  assist: FloatingAssist;
  muted: string;
  dark: boolean;
}) {
  const [period, setPeriod] = useState<"recent" | "all">("recent");
  const hasContent = assist.recent || assist.topics.length > 0;

  return (
    <div className="flex flex-col gap-3 pt-1">
      <div
        className="flex self-start rounded-full p-[3px]"
        style={{
          background: dark ? "rgba(0,0,0,0.18)" : "rgba(31,28,26,0.07)",
        }}
      >
        {(["recent", "all"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={period === value}
            onClick={() => setPeriod(value)}
            className="rounded-full px-3 py-1 text-[12px] font-medium"
            style={{
              color: period === value ? undefined : muted,
              background:
                period === value ? "rgba(255,255,255,0.2)" : undefined,
            }}
          >
            {value === "recent"
              ? assist.labels.lastMinutes
              : assist.labels.sinceStart}
          </button>
        ))}
      </div>
      {!hasContent ? (
        <p className="text-[13px]" style={{ color: muted }}>
          {assist.labels.emptySummary}
        </p>
      ) : period === "recent" ? (
        <p className="text-[14.5px] leading-[1.52]">{assist.recent}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {assist.decisions.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <SectionTitle muted={muted}>
                {assist.labels.decisions}
              </SectionTitle>
              {assist.decisions.map((decision) => (
                <p
                  key={decision}
                  className="border-l-2 pl-2.5 text-[13px]"
                  style={{ borderColor: "rgb(139, 224, 171)" }}
                >
                  {decision}
                </p>
              ))}
            </div>
          ) : null}
          {assist.topics.map((topic, index) => (
            <div
              key={`${topic.title}-${index}`}
              className="grid grid-cols-[44px_minmax(0,1fr)] gap-2.5"
            >
              <span
                className="pt-0.5 font-mono text-[11px]"
                style={{ color: muted }}
              >
                {topic.start ?? ""}
              </span>
              <div>
                <p className="mb-0.5 flex items-center gap-2 text-[13px] font-semibold">
                  {topic.title}
                  {topic.live ? (
                    <span
                      aria-hidden
                      className="inline-block size-1.5 rounded-full"
                      style={{ background: "rgb(255, 69, 92)" }}
                    />
                  ) : null}
                </p>
                <ul className="list-disc pl-4 text-[12.5px] leading-[1.45]">
                  {topic.bullets.map((bullet) => (
                    <li key={bullet}>{bullet}</li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
