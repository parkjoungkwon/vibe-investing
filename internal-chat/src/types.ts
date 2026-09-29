export type UserRole = "member" | "admin";

export type ChannelType = "public" | "private" | "dm";

export type User = {
  id: number;
  email: string;
  display_name: string;
  role: UserRole;
  created_at: string;
};

export type Channel = {
  id: number;
  type: ChannelType;
  name: string;
  created_by: number | null;
  created_at: string;
};

export type Message = {
  id: number;
  channel_id: number;
  user_id: number;
  parent_id: number | null;
  body: string;
  created_at: string;
};

export type Attachment = {
  id: number;
  message_id: number;
  original_name: string;
  stored_name: string;
  mime: string;
  size: number;
  created_at: string;
};

export type AuditRow = {
  id: number;
  actor_id: number | null;
  action: string;
  detail: string;
  created_at: string;
};

export function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${String(value)}`);
}
