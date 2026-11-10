import { Link } from "react-router";

import type { CardNotice, NoticeTarget } from "../cards/card-notice";

const pillClass =
  "inline-block max-w-full rounded-[14px] bg-muted px-3 py-1 text-center text-xs leading-[18px] text-muted-foreground [overflow-wrap:anywhere]";

/**
 * A settled card as one centered system line, like a Room notice. Once
 * decided it is only a record; the object in the line links to where the
 * result lives.
 */
export function CardNoticeRows({
  notice,
  tenantId,
}: {
  notice: CardNotice;
  tenantId: string;
}) {
  return (
    <div
      className="room-notice-row flex flex-col items-center gap-1.5 py-1"
      data-message-kind="card_notice"
      role="note"
    >
      <span className={pillClass}>
        {notice.text}
        {notice.link ? (
          <Link
            className="font-medium text-app-ink underline-offset-2 hover:underline"
            to={targetPath(tenantId, notice.link.to)}
          >
            {notice.link.label}
          </Link>
        ) : null}
      </span>
      {notice.more?.map((line) => (
        <span className={pillClass} key={line}>
          {line}
        </span>
      ))}
    </div>
  );
}

function targetPath(tenantId: string, to: NoticeTarget) {
  const tenant = `/t/${encodeURIComponent(tenantId)}`;
  return to === "apps"
    ? `${tenant}/apps`
    : `${tenant}/rooms/${encodeURIComponent(to.room)}/chat`;
}
