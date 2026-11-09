export interface Review {
  user: { login: string; type: string } | null;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  commit_id: string | null;
  submitted_at: string | null;
}

export interface ApprovalInput {
  reviews: Review[];
  // Approvals on any other commit are stale, because the ruleset requires approval of the latest push.
  headSha: string;
  // The developer who ran the agent. Agents push under this account, so it never counts as a peer.
  author: string;
}

export interface ApprovalCount {
  approvers: string[];
  total: number;
}

const lower = (login: string) => login.toLowerCase();

// Counts the people whose latest review of the head commit is an approval.
export function countApprovals(input: ApprovalInput): ApprovalCount {
  const author = lower(input.author);
  const ordered = input.reviews
    .filter((review) => review.user && review.user.type !== "Bot" && lower(review.user.login) !== author)
    .sort((a, b) => (a.submitted_at ?? "").localeCompare(b.submitted_at ?? ""));

  // A comment leaves an earlier verdict standing, as it does on GitHub, so only the other states replace it.
  const standing = new Map<string, Review | null>();
  for (const review of ordered) {
    const login = lower(review.user!.login);
    if (review.state === "APPROVED") standing.set(login, review);
    else if (review.state === "CHANGES_REQUESTED" || review.state === "DISMISSED") standing.set(login, null);
  }

  const approvers = [...standing]
    .filter(([, review]) => review !== null && review.commit_id === input.headSha)
    .map(([login]) => login)
    .sort();
  return { approvers, total: approvers.length };
}
