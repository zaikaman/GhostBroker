import { authenticate } from "./setup-trade-pair-helper.js";

const buyerToken = (await authenticate("gbk_DnOR8QnB_DnOR8QnBra5M5dUjnG_j2vxDyH6ILQspjIfnYwhD0GU")).token;
const start = Date.now();

interface RoundView { roundNumber: number; actorSide: string; moveType: string; strategicIntent: string | null; createdAt: string; }
interface Session { id: string; status: string; currentTurn: string; roundNumber: number; maxRounds: number; deadline: string; tradeRef: string | null; rounds: RoundView[]; updatedAt: string; }

let lastRound = 0;

while (Date.now() - start < 60_000) {
  const r = await fetch("http://localhost:3001/api/negotiations", { headers: { Authorization: "Bearer " + buyerToken } });
  const j = (await r.json()) as { sessions: Session[] };
  const fresh = j.sessions
    .filter((s) => s.buyInstitutionId === "00000000-0000-4000-8000-0000000007a1" && s.sellInstitutionId === "00000000-0000-4000-8000-0000000007a2")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

  if (fresh) {
    if (fresh.rounds.length > lastRound) {
      for (const round of fresh.rounds.slice(lastRound)) {
        const ts = new Date(round.createdAt).toISOString();
        console.log(`  + R${round.roundNumber} [${round.actorSide}/${round.moveType}] strategicIntent=${round.strategicIntent ?? "?"} :: ${ts}`);
      }
      lastRound = fresh.rounds.length;
    }
    process.stdout.write(
      `\r[watch] status=${fresh.status} turn=${fresh.currentTurn} round=${fresh.roundNumber}/${fresh.maxRounds} deadline=${fresh.deadline}    `
    );
    if (fresh.status === "settled" || fresh.status === "walked_away" || fresh.status === "expired") {
      console.log(`\n[watch] final: ${fresh.status} tradeRef=${fresh.tradeRef ?? "n/a"}`);
      break;
    }
  }
  await new Promise((r) => setTimeout(r, 1500));
}
