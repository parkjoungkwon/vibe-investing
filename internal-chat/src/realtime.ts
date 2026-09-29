import type { Response } from "express";
import type { DatabaseSync } from "node:sqlite";

type Client = {
  userId: number;
  res: Response;
};

export class RealtimeHub {
  private clients = new Set<Client>();

  add(userId: number, res: Response): void {
    const client = { userId, res };
    this.clients.add(client);
    res.on("close", () => {
      this.clients.delete(client);
    });
  }

  emitToChannel(
    db: DatabaseSync,
    channelId: number,
    event: string,
    payload: unknown,
  ): void {
    const members = db
      .prepare("SELECT user_id FROM channel_members WHERE channel_id = ?")
      .all(channelId) as Array<{ user_id: number }>;
    const ids = new Set(members.map((row) => row.user_id));
    const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) {
      if (!ids.has(client.userId)) continue;
      client.res.write(line);
    }
  }
}
