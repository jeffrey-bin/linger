import type { ReactNode } from "react";
import { Link } from "react-router";

import { ActorAvatar } from "../members/actor-avatar";
import { useProfileCardContent } from "./profile-card-content";

/**
 * A Message an Agent sent with `teamhub message card`: its files as ordinary
 * file items, without the card's title. It delivers a finished
 * background Task's result or something the person must notice, and stays as
 * small as an ordinary reply. Its text body is shown only on a Personal
 * Profile delivery; the Agent says anything else in an ordinary reply.
 */
interface ProfileCardInfo {
  actorId: string;
  wikiPath: string;
  subtitle?: string;
  tenantId: string;
  roomId: string;
  authorId: string;
}

interface MessageCardProps {
  children: ReactNode;
  /** The Message's file items, or nothing when it has none. */
  files?: ReactNode;
  profile?: ProfileCardInfo;
  profileChildren?: ReactNode;
  title: string;
}

export function MessageCard(props: MessageCardProps) {
  return props.profile ? (
    <ProfileCardCandidate {...props} profile={props.profile} />
  ) : (
    <MessageCardLayout {...props} children={null} />
  );
}

function ProfileCardCandidate(
  props: MessageCardProps & { profile: ProfileCardInfo },
) {
  const content = useProfileCardContent({
    children: props.profileChildren ?? props.children,
    tenantId: props.profile.tenantId,
    roomId: props.profile.roomId,
    authorId: props.profile.authorId,
  });
  return (
    <MessageCardLayout
      {...props}
      profile={content.isOwnProfileDelivery ? props.profile : undefined}
      profileContent={content}
    />
  );
}

function MessageCardLayout({
  children,
  files,
  profile,
  title,
  profileContent,
}: MessageCardProps & {
  profileContent?: ReturnType<typeof useProfileCardContent>;
}) {
  if (!profile) {
    // A delivery shows only its files, like any Message's files; the Agent
    // says what they are in its own words. A card without files, or a
    // profile card someone else reads, keeps its title and text as the
    // Agent's plain words.
    return (
      <section
        aria-label={title}
        className="flex flex-col items-start"
        data-message-card
      >
        {children || !files ? (
          <p className="card-prompt [overflow-wrap:anywhere]">{title}</p>
        ) : null}
        {children ? (
          <div className="card-prompt mt-1 min-w-0 text-app-body">
            {children}
          </div>
        ) : null}
        {files ? (
          <div className="flex w-full flex-col items-start gap-1.5">
            {files}
          </div>
        ) : null}
      </section>
    );
  }
  return (
    <section
      aria-label={title}
      className={
        profile
          ? "flex w-[min(var(--chat-card-width),100%)] flex-col gap-3 rounded-xl border border-app-border bg-app-surface p-4 shadow-[var(--chat-card-shadow)]"
          : "flex w-[min(var(--chat-card-width),100%)] flex-col gap-1.5 rounded-lg border border-app-border bg-app-surface p-2.5 shadow-[var(--chat-card-shadow)]"
      }
      data-message-card
    >
      <div className={profile ? "flex items-center gap-3" : "px-1"}>
        {profile ? (
          <ActorAvatar
            actorId={profile.actorId}
            kind="human"
            name={title}
            size="card"
          />
        ) : null}
        <div className="min-w-0">
          <p
            className={
              profile
                ? "text-sm font-[580] text-app-ink"
                : "text-sm leading-5 font-[580] text-app-ink"
            }
          >
            {title}
          </p>
          {profile?.subtitle ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {profile.subtitle}
            </p>
          ) : null}
        </div>
      </div>
      {profile || children ? (
        <div className="min-w-0 text-app-body">
          {profile ? profileContent?.body : children}
        </div>
      ) : null}
      {files ? (
        <div className="flex flex-col items-start gap-1.5">{files}</div>
      ) : null}
      {profile ? (
        <div className="flex items-center justify-between gap-3 border-t border-app-border pt-3">
          {profileContent?.sources ?? <span />}
          <Link
            className="inline-flex min-h-9 items-center justify-center rounded-full border border-app-border px-4 text-sm font-medium text-app-ink transition-colors hover:bg-app-surface-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-focus"
            to={profile.wikiPath}
          >
            Open
          </Link>
        </div>
      ) : null}
    </section>
  );
}
