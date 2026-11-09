#!/usr/bin/env node

import { execSync } from 'child_process';

const REPO = 'stormrockwell/media-on-autopilot';

function runCommand(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    return '';
  }
}

function getMergedPRs() {
  const cmd = `gh pr list --repo ${REPO} --state merged --limit 1000 --json number,createdAt,mergedAt,title,reviews`;
  const output = runCommand(cmd);
  if (!output.trim()) return [];
  try {
    return JSON.parse(output);
  } catch {
    return [];
  }
}

function getCommitsOnBranch() {
  // Fetch all commits using gh api with proper pagination
  const cmd = `gh api repos/${REPO}/commits --paginate -q '.[].commit | {message: .message, date: .author.date}' 2>/dev/null`;
  const output = runCommand(cmd);

  if (!output.trim()) return [];

  const commits = [];
  const lines = output.split('\n').filter(l => l.trim());

  for (const line of lines) {
    try {
      const commit = JSON.parse(line);
      if (commit.message) {
        commits.push(commit);
      }
    } catch {}
  }

  return commits;
}

function analyzeCommits(commits) {
  let conventionalCount = 0;
  let revertCount = 0;
  let fixCount = 0;

  for (const commit of commits) {
    const message = commit.message || '';
    const firstLine = message.split('\n')[0];

    if (firstLine.startsWith('Revert ')) {
      revertCount += 1;
    }

    if (firstLine.match(/^fix(\(.+\))?:/)) {
      fixCount += 1;
    }

    if (firstLine.match(/^(feat|fix|docs|style|refactor|perf|test|chore)(\(.+\))?:/)) {
      conventionalCount += 1;
    }
  }

  return { conventionalCount, revertCount, fixCount };
}

function groupByWeek(items, dateField) {
  const weeks = new Map();

  for (const item of items) {
    const date = new Date(item[dateField]);
    const weekStart = new Date(date);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const weekKey = weekStart.toISOString().split('T')[0];

    weeks.set(weekKey, (weeks.get(weekKey) || 0) + 1);
  }

  return weeks;
}

function calculateMetrics(prs, commits) {
  const metrics = {};

  // PR metrics
  metrics.prCount = prs.length;

  if (prs.length > 0) {
    const prsByWeek = groupByWeek(prs, 'mergedAt');
    metrics.prPerWeekValues = Array.from(prsByWeek.values()).sort((a, b) => a - b);
    metrics.prPerWeekAvg = (metrics.prPerWeekValues.reduce((a, b) => a + b, 0) / metrics.prPerWeekValues.length).toFixed(2);

    // Hours from open to merge
    const openToMergeHours = prs.map(pr => {
      const opened = new Date(pr.createdAt);
      const merged = new Date(pr.mergedAt);
      return (merged - opened) / (1000 * 60 * 60);
    }).sort((a, b) => a - b);

    const len = openToMergeHours.length;
    const p50Index = Math.floor(len * 0.5);
    const p90Index = Math.floor(len * 0.9);

    metrics.medianHours = openToMergeHours[p50Index].toFixed(1);
    metrics.p90Hours = openToMergeHours[Math.min(p90Index, len - 1)].toFixed(1);

    // Review comments per PR (sum of review comments across all PRs)
    let totalReviewComments = 0;
    for (const pr of prs) {
      if (pr.reviews && Array.isArray(pr.reviews)) {
        for (const review of pr.reviews) {
          if (review.body) {
            totalReviewComments += 1;
          }
        }
      }
    }
    metrics.reviewCommentsPerPR = (totalReviewComments / prs.length).toFixed(2);
  } else {
    metrics.prPerWeekAvg = '0';
    metrics.medianHours = '0';
    metrics.p90Hours = '0';
    metrics.reviewCommentsPerPR = '0';
  }

  // Commits metrics
  metrics.commitCount = commits.length;

  if (commits.length > 0) {
    const commitsByWeek = groupByWeek(commits, 'date');
    metrics.commitsPerWeekValues = Array.from(commitsByWeek.values()).sort((a, b) => a - b);
    metrics.commitsPerWeekAvg = (metrics.commitsPerWeekValues.reduce((a, b) => a + b, 0) / metrics.commitsPerWeekValues.length).toFixed(2);

    const analysis = analyzeCommits(commits);
    metrics.conventionalShare = ((analysis.conventionalCount / commits.length) * 100).toFixed(1);
    metrics.revertCount = analysis.revertCount;
    metrics.fixCount = analysis.fixCount;
  } else {
    metrics.commitsPerWeekAvg = '0';
    metrics.conventionalShare = '0';
    metrics.revertCount = 0;
    metrics.fixCount = 0;
  }

  return metrics;
}

async function main() {
  console.log('Fetching data from', REPO);

  const prs = getMergedPRs();
  console.log(`Found ${prs.length} merged PRs`);

  const commits = getCommitsOnBranch();
  console.log(`Found ${commits.length} commits`);

  const metrics = calculateMetrics(prs, commits);

  // Build markdown output
  const today = new Date().toISOString().split('T')[0];
  let markdown = '# Baseline Metrics\n\n';

  const dateRange = prs.length > 0 || commits.length > 0
    ? `${REPO} (data collected on ${today})`
    : `${REPO} (data collected on ${today}) - no data available`;

  markdown += `${dateRange}\n\n`;

  markdown += '| Metric | Value |\n';
  markdown += '|--------|-------|\n';
  markdown += `| Merged PRs | ${metrics.prCount} |\n`;
  markdown += `| PRs per week (avg) | ${metrics.prPerWeekAvg} |\n`;
  markdown += `| Median hours PR open | ${metrics.medianHours} |\n`;
  markdown += `| P90 hours PR open | ${metrics.p90Hours} |\n`;
  markdown += `| Review comments per PR | ${metrics.reviewCommentsPerPR} |\n`;
  markdown += `| Total commits (default branch) | ${metrics.commitCount} |\n`;
  markdown += `| Commits per week (avg) | ${metrics.commitsPerWeekAvg} |\n`;
  markdown += `| Conventional commits % | ${metrics.conventionalShare}% |\n`;
  markdown += `| Revert commits | ${metrics.revertCount} |\n`;
  markdown += `| Fix commits | ${metrics.fixCount} |\n\n`;

  let limitations = '';
  if (metrics.prCount === 0) {
    limitations = 'No merged PRs found; PR metrics cannot be calculated.';
  } else if (parseFloat(metrics.reviewCommentsPerPR) === 0) {
    limitations = 'No review comments found in merged PRs.';
  }

  if (metrics.commitCount === 0) {
    limitations = limitations ? limitations + ' No commits found on default branch.' : 'No commits found on default branch; commit metrics cannot be calculated.';
  }

  if (limitations) {
    markdown += `Note: ${limitations}\n`;
  }

  // Write to file
  const fs = await import('fs/promises');
  await fs.writeFile('/Users/storm/Documents/web/dev-pipeline/docs/spikes/0.3-baseline.md', markdown);

  console.log('\nMetrics written to /Users/storm/Documents/web/dev-pipeline/docs/spikes/0.3-baseline.md');
  console.log(`\nHeadline: ${metrics.prCount} merged PRs, ${metrics.commitCount} commits, ${metrics.conventionalShare}% conventional commits`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
