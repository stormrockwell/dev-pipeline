import { describe, expect, it } from "vitest";
import { countApprovals, type Review } from "../../src/commands/risk-gate/reviews.ts";

const HEAD = "bbbb";
const review = (login: string, state: Review["state"], at: string, extra: Partial<Review> = {}): Review => ({
  user: { login, type: "User" },
  state,
  commit_id: HEAD,
  submitted_at: at,
  ...extra,
});

const base = { headSha: HEAD, author: "dev", zoneApprovers: ["lead"], trusted: [] as string[] };

describe("countApprovals", () => {
  it("counts distinct approvers and the zone approvers among them", () => {
    const result = countApprovals({
      ...base,
      reviews: [review("lead", "APPROVED", "2026-01-01T00:00:00Z"), review("peer", "APPROVED", "2026-01-01T00:01:00Z")],
    });
    expect(result).toMatchObject({ total: 2, zone: 1, approvers: ["lead", "peer"] });
  });

  it("counts a person once, however many times they approve", () => {
    const result = countApprovals({
      ...base,
      reviews: [review("peer", "APPROVED", "2026-01-01T00:00:00Z"), review("peer", "APPROVED", "2026-01-01T00:05:00Z")],
    });
    expect(result.total).toBe(1);
  });

  it("never counts the author", () => {
    expect(countApprovals({ ...base, zoneApprovers: ["dev"], reviews: [review("dev", "APPROVED", "2026-01-01T00:00:00Z")] })).toMatchObject({ total: 0, zone: 0 });
  });

  it("never counts a bot", () => {
    const bot = review("ci-bot", "APPROVED", "2026-01-01T00:00:00Z", { user: { login: "ci-bot", type: "Bot" } });
    expect(countApprovals({ ...base, reviews: [bot] }).total).toBe(0);
  });

  it("ignores an approval on an older commit", () => {
    const stale = review("lead", "APPROVED", "2026-01-01T00:00:00Z", { commit_id: "aaaa" });
    expect(countApprovals({ ...base, reviews: [stale] }).total).toBe(0);
  });

  it("lets a later change request withdraw an approval", () => {
    const result = countApprovals({
      ...base,
      reviews: [review("lead", "APPROVED", "2026-01-01T00:00:00Z"), review("lead", "CHANGES_REQUESTED", "2026-01-01T00:10:00Z")],
    });
    expect(result.total).toBe(0);
  });

  it("lets a dismissal withdraw an approval", () => {
    const result = countApprovals({
      ...base,
      reviews: [review("lead", "APPROVED", "2026-01-01T00:00:00Z"), review("lead", "DISMISSED", "2026-01-01T00:10:00Z")],
    });
    expect(result.total).toBe(0);
  });

  it("keeps an approval when a later review is only a comment", () => {
    const result = countApprovals({
      ...base,
      reviews: [review("lead", "APPROVED", "2026-01-01T00:00:00Z"), review("lead", "COMMENTED", "2026-01-01T00:10:00Z")],
    });
    expect(result.total).toBe(1);
  });

  it("orders reviews by time, not by array position", () => {
    const result = countApprovals({
      ...base,
      reviews: [review("lead", "CHANGES_REQUESTED", "2026-01-01T00:10:00Z"), review("lead", "APPROVED", "2026-01-01T00:00:00Z")],
    });
    expect(result.total).toBe(0);
  });

  it("matches logins without regard to case", () => {
    const result = countApprovals({ ...base, zoneApprovers: ["Lead"], reviews: [review("LEAD", "APPROVED", "2026-01-01T00:00:00Z")] });
    expect(result).toMatchObject({ total: 1, zone: 1 });
  });

  it("counts a trusted author as one approval that is not a zone approval", () => {
    const result = countApprovals({ ...base, trusted: ["dev"], reviews: [] });
    expect(result).toMatchObject({ total: 1, zone: 0, trustedAuthor: true });
  });
});
