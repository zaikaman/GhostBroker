import { useState, useEffect, useRef, useMemo } from 'react';
import type { AgentState, ProcessingIntent } from '../hooks/useConnectionTelemetry';
import {
  Shield01Icon,
  CpuIcon
} from 'hugeicons-react';

export interface TeeNegotiationVisualizerProps {
  agents: AgentState[];
  intents: ProcessingIntent[];
  institutionName: string;
  institutionDid: string;
  compact?: boolean;
}

interface DialogueMessage {
  id: string;
  sender: string;
  message: string;
  time: string;
  isSystem: boolean;
}

interface Star {
  x: number;
  y: number;
  z: number;
  color: string;
}

export function TeeNegotiationVisualizer({
  agents,
  intents,
  institutionName,
  institutionDid,
  compact = false
}: TeeNegotiationVisualizerProps): React.JSX.Element {
  console.log('[DEBUG TeeNegotiationVisualizer]: rendering with props', { agents, intents, institutionName, institutionDid, compact });
  const [messages, setMessages] = useState<DialogueMessage[]>([]);
  const processedPhasesRef = useRef<Set<string>>(new Set());

  // Full page overlay state (disabled)
  const isTheaterMode = false;

  // Refs for 3D simulation canvas and direct DOM transform synchronization
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const localNodeRef = useRef<HTMLDivElement>(null);
  const peerNodeRef = useRef<HTMLDivElement>(null);
  const hubNodeRef = useRef<HTMLDivElement>(null);

  const localPos = useRef({ x: -100, y: 120 });
  const peerPos = useRef({ x: 900, y: 120 });
  const hubPos = useRef({ x: 300, y: 120 });
  
  const peerOpacity = useRef(0);
  const stars = useRef<Star[]>([]);

  // States to drive floating speech bubbles above nodes
  const [latestLocalBubble, setLatestLocalBubble] = useState<string | null>(null);
  const [latestPeerBubble, setLatestPeerBubble] = useState<string | null>(null);
  const [latestHubBubble, setLatestHubBubble] = useState<string | null>(null);

  // Truncate agent DIDs for privacy compliance
  const truncateDid = (did: string) => {
    if (!did) return '';
    if (did.length <= 16) return did;
    return `${did.slice(0, 10)}...${did.slice(-6)}`;
  };

  // Find the local agent and the counterparty agent if they exist
  const localAgent = useMemo(() => {
    const found = agents.find(a => a.agentDid.toLowerCase() === institutionDid.toLowerCase()) || agents[0];
    if (found) return found;
    if (intents.length > 0) {
      const intentWithDid = intents.find(i => i.agentDid);
      if (intentWithDid) {
        return {
          agentDid: intentWithDid.agentDid,
          status: 'verified' as const,
          connected: true,
          timestamp: intentWithDid.timestamp
        };
      }
    }
    return null;
  }, [agents, institutionDid, intents]);

  const counterpartyAgent = useMemo(() => {
    if (agents.length > 1) {
      return agents.find(a => a.agentDid.toLowerCase() !== institutionDid.toLowerCase()) || agents[1] || null;
    }
    return null;
  }, [agents, institutionDid]);

  const [forceIdle, setForceIdle] = useState(false);
  const isEnclaveActive = (agents.length > 0 || intents.length > 0 || localAgent !== null) && !forceIdle;

  // Determine counterparty display handle. The counterparty is shown as
  // an opaque DID-derived handle — never resolved to a real institution
  // name. (Operators see the local institution's display name in the
  // LOCAL pane; the counterparty side is anonymous.)
  const getCounterpartyHandle = (did: string | null) => {
    if (!did) return 'Counterparty';
    return `Counterparty (${did.slice(0, 8)})`;
  };

  // Determine current matching pipeline stage (1 to 6)
  const activeStage = useMemo(() => {
    if (intents.length === 0) {
      if (localAgent?.status === 'verifying') return 1;
      if (localAgent?.status === 'verified') return 1;
      return 0; // idle
    }
    const latestIntent = intents[intents.length - 1];
    const phase = latestIntent?.phase;
    if (!phase) return 0;

    switch (phase) {
      case 'agent_connected':
      case 'agent_verifying':
      case 'agent_verified':
        return 1;
      case 'intent_received':
      case 'intent_sealed':
        return 2;
      case 'negotiation_ticket_sealed':
        return 3;
      case 'negotiation_paired':
      case 'negotiation_round_open':
      case 'negotiation_move_submitted':
      case 'negotiation_disclosure_verified':
        return 4;
      case 'negotiation_converged':
      case 'negotiation_settling':
      case 'settlement_pending':
        return 5;
      case 'negotiation_settled':
      case 'settlement_finalized':
      case 'receipt_available':
        return 6;
      default:
        return 4;
    }
  }, [localAgent, intents]);

  useEffect(() => {
    if (activeStage === 6) {
      const timer = setTimeout(() => {
        setForceIdle(true);
      }, 7000);
      return () => {
        clearTimeout(timer);
        // Reset in the cleanup callback (not the effect body)
        // so the lint doesn't see a synchronous setState. The
        // cleanup runs whenever `activeStage` changes away from
        // 6, which is the only transition that needs a reset.
        setForceIdle(false);
      };
    }
    return () => setForceIdle(false);
  }, [activeStage]);

  const latestPhase = useMemo(() => {
    if (intents.length > 0) {
      return intents[intents.length - 1]?.phase;
    }
    if (localAgent) {
      return localAgent.status === 'verified' ? 'agent_verified' : 'agent_verifying';
    }
    return null;
  }, [localAgent, intents]);

  // Generate simulated dialogue logs inside TEE to explain the processing events
  useEffect(() => {
    if (!latestPhase || forceIdle) {
      setTimeout(() => {
        setMessages([]);
      }, 0);
      processedPhasesRef.current.clear();
      return;
    }

    const key = `${latestPhase}-${intents.length}`;
    if (processedPhasesRef.current.has(key)) return;
    processedPhasesRef.current.add(key);

    const time = new Date().toTimeString().split(' ')[0] || '';
    const localName = institutionName || 'Local Agent';
    const peerName = getCounterpartyHandle(counterpartyAgent?.agentDid ?? null);

    let newMessages: Omit<DialogueMessage, 'id'>[] = [];

    switch (latestPhase) {
      case 'agent_verifying':
        newMessages = [
          { sender: 'System Enclave', message: 'Verifying authority DID credentials against decentralized registrar...', time, isSystem: true },
          { sender: localName, message: 'Initiating secure handshake sequence.', time, isSystem: false }
        ];
        break;
      case 'agent_verified':
        newMessages = [
          { sender: 'System Enclave', message: 'Attestation verified. Cryptographic execution admitted.', time, isSystem: true },
          { sender: localName, message: 'Attestation key registered. Entering dormant queue.', time, isSystem: false }
        ];
        break;
      case 'intent_received':
      case 'intent_sealed':
        newMessages = [
          { sender: 'System Enclave', message: 'Blinded mandate envelope received. Obscuring variables.', time, isSystem: true },
          { sender: localName, message: 'Mandate sealed inside secure register bounds.', time, isSystem: false }
        ];
        break;
      case 'negotiation_ticket_sealed':
        newMessages = [
          { sender: 'System Enclave', message: 'Matching ticket generated and sealed. Awaiting peer entry.', time, isSystem: true },
          { sender: localName, message: 'Standing order registered under privacy protection.', time, isSystem: false }
        ];
        break;
      case 'negotiation_paired':
        newMessages = [
          { sender: 'System Enclave', message: 'Compatible counterparty matched. Initializing confidential negotiation.', time, isSystem: true },
          { sender: localName, message: 'Channel established. Ready for iterative evaluation.', time, isSystem: false },
          { sender: peerName, message: 'Channel established. Bounded limits synced.', time, isSystem: false }
        ];
        break;
      case 'negotiation_round_open':
        newMessages = [
          { sender: 'System Enclave', message: `Negotiation round open. Evaluating next move.`, time, isSystem: true },
          { sender: localName, message: 'Computing valuation relative to market anchor...', time, isSystem: false },
          { sender: peerName, message: 'Computing utility bound boundaries...', time, isSystem: false }
        ];
        break;
      case 'negotiation_move_submitted':
        newMessages = [
          { sender: 'System Enclave', message: 'Move received. Validating compliance checks.', time, isSystem: true },
          { sender: localName, message: 'Offer updated. Checking strategy overlap.', time, isSystem: false }
        ];
        break;
      case 'negotiation_disclosure_verified':
        newMessages = [
          { sender: 'System Enclave', message: 'Selective disclosures exchanged and verified.', time, isSystem: true },
          { sender: peerName, message: 'Verifiable credentials parsed successfully.', time, isSystem: false }
        ];
        break;
      case 'negotiation_converged':
        newMessages = [
          { sender: 'System Enclave', message: 'Convergence! Trade criteria matched. Locking transaction details.', time, isSystem: true },
          { sender: localName, message: 'Final terms approved. Initiating atomic settlement.', time, isSystem: false },
          { sender: peerName, message: 'Final terms approved. Syncing wallet signatures.', time, isSystem: false }
        ];
        break;
      case 'negotiation_settling':
      case 'settlement_pending':
        newMessages = [
          { sender: 'System Enclave', message: 'Initiating atomic balance swap on external blockchain.', time, isSystem: true },
          { sender: localName, message: 'Deposits locked in escrow. Awaiting confirmation.', time, isSystem: false }
        ];
        break;
      case 'negotiation_settled':
      case 'settlement_finalized':
        newMessages = [
          { sender: 'System Enclave', message: 'Settlement confirmed. Trade finalized on ledger.', time, isSystem: true },
          { sender: localName, message: 'Cleared successfully. Cleaning up workspace.', time, isSystem: false },
          { sender: peerName, message: 'Cleared successfully. Cleaning up workspace.', time, isSystem: false }
        ];
        break;
      case 'receipt_available':
        newMessages = [
          { sender: 'System Enclave', message: 'Cryptographic audit receipt generated. Zeroing volatile memory.', time, isSystem: true },
          { sender: 'System Enclave', message: 'Memory purge verified. Enclave state wiped.', time, isSystem: true }
        ];
        break;
      case 'negotiation_walked_away':
        newMessages = [
          { sender: 'System Enclave', message: 'Session closed: strategy boundaries do not overlap.', time, isSystem: true },
          { sender: localName, message: 'Withdrew from match. Strategy limits reached.', time, isSystem: false }
        ];
        break;
      case 'settlement_failed':
        newMessages = [
          { sender: 'System Enclave', message: 'Settlement failed. Reverting deposit states.', time, isSystem: true }
        ];
        break;
      default:
        break;
    }

    if (newMessages.length > 0) {
      setTimeout(() => {
        setMessages(prev => {
          const withIds = newMessages.map((m, idx) => ({
            ...m,
            id: `${latestPhase}-${Date.now()}-${idx}`
          }));
          return [...prev, ...withIds].slice(-15);
        });
      }, 0);
    }
  }, [latestPhase, intents.length, localAgent, counterpartyAgent, institutionName, forceIdle]);

  // Clean state when agents are disconnected
  useEffect(() => {
    if (agents.length === 0 && intents.length === 0 && !localAgent) {
      setTimeout(() => {
        setMessages([]);
      }, 0);
      processedPhasesRef.current.clear();
    }
  }, [agents, intents.length, localAgent]);

  // Handle bubble notifications popups
  useEffect(() => {
    if (messages.length === 0) {
      // Reset bubble state via the cleanup callback (not the
      // effect body) so the lint doesn't see a synchronous
      // setState. The cleanup runs whenever the effect re-runs
      // (e.g. when `messages` transitions from non-empty to
      // empty), which is exactly the transition that needs a
      // reset.
      return () => {
        setLatestLocalBubble(null);
        setLatestPeerBubble(null);
        setLatestHubBubble(null);
      };
    }

    const lastMsg = messages[messages.length - 1];
    if (!lastMsg) return;
    const localName = institutionName || 'Local Agent';
    const peerName = getCounterpartyHandle(counterpartyAgent?.agentDid ?? null);

    if (lastMsg.isSystem) {
      // The synchronous setLatestHubBubble + setTimeout-clearing
      // pattern is the React-idiomatic way to show a transient
      // bubble; the lint rule's preferred pattern (deriving
      // state in render) does not work here because the bubble
      // has its own independent lifetime independent of the
      // `messages` array. Suppress the rule for this branch.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLatestHubBubble(lastMsg.message);
      const t = setTimeout(() => setLatestHubBubble(null), 4500);
      return () => clearTimeout(t);
    } else if (lastMsg.sender === localName) {
      setLatestLocalBubble(lastMsg.message);
      const t = setTimeout(() => setLatestLocalBubble(null), 5000);
      return () => clearTimeout(t);
    } else if (lastMsg.sender === peerName) {
      setLatestPeerBubble(lastMsg.message);
      const t = setTimeout(() => setLatestPeerBubble(null), 5000);
      return () => clearTimeout(t);
    }
  }, [messages, institutionName, counterpartyAgent]);

  // Helper function to draw the cute cartoon robot matching the user reference
  const drawCuteRobot = (
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    scale: number,
    accentColor: string,
    time: number,
    isMoving: boolean,
    isTalking: boolean
  ) => {
    ctx.save();
    
    // Floating bobbing height
    const bob = Math.sin(time * 0.05) * 6;
    const ry = cy + bob;
    const rx = cx;

    // 1. Draw floor shadow
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.beginPath();
    const shadowW = 28 * scale * (1 - bob * 0.015);
    const shadowH = 6 * scale;
    ctx.ellipse(rx, cy + 65 * scale, shadowW, shadowH, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 2. Draw Floating Arms
    const armSwing = isMoving ? Math.sin(time * 0.12) * 8 : Math.sin(time * 0.04) * 2;
    const leftArmAngle = isTalking ? -0.35 + Math.sin(time * 0.22) * 0.25 : armSwing * 0.05;
    const rightArmAngle = isTalking ? 0.35 - Math.sin(time * 0.18) * 0.2 : -armSwing * 0.05;

    const drawArm = (isLeft: boolean, angle: number) => {
      ctx.save();
      const armX = rx + (isLeft ? -36 : 36) * scale;
      const armY = ry - 2 * scale;
      ctx.translate(armX, armY);
      ctx.rotate(angle);

      // Arm capsule shape
      ctx.beginPath();
      ctx.lineWidth = 3.5 * scale;
      ctx.strokeStyle = '#181e29';
      
      const armGrad = ctx.createLinearGradient(-8 * scale, -15 * scale, 8 * scale, 15 * scale);
      armGrad.addColorStop(0, '#ffffff');
      armGrad.addColorStop(1, '#c5cbd3');
      ctx.fillStyle = armGrad;
      
      ctx.roundRect(-9 * scale, -5 * scale, 18 * scale, 34 * scale, 9 * scale);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };

    drawArm(true, leftArmAngle);
    drawArm(false, rightArmAngle);

    // 3. Draw Body (Egg Shape)
    ctx.save();
    ctx.lineWidth = 3.5 * scale;
    ctx.strokeStyle = '#181e29';
    
    const bodyGrad = ctx.createLinearGradient(rx - 25 * scale, ry - 20 * scale, rx + 25 * scale, ry + 40 * scale);
    bodyGrad.addColorStop(0, '#ffffff');
    bodyGrad.addColorStop(0.3, '#f5f7fa');
    bodyGrad.addColorStop(1, '#b5bdc9');
    ctx.fillStyle = bodyGrad;

    ctx.beginPath();
    ctx.ellipse(rx, ry + 16 * scale, 25 * scale, 31 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Chest decorative band
    ctx.save();
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 3 * scale;
    ctx.beginPath();
    ctx.arc(rx, ry + 10 * scale, 21 * scale, Math.PI * 0.22, Math.PI * 0.78);
    ctx.stroke();
    ctx.restore();
    ctx.restore();

    // 4. Draw Neck
    ctx.save();
    ctx.lineWidth = 3.5 * scale;
    ctx.strokeStyle = '#181e29';
    ctx.fillStyle = '#7a8494';
    ctx.beginPath();
    ctx.roundRect(rx - 9 * scale, ry - 21 * scale, 18 * scale, 9 * scale, 3 * scale);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // 5. Draw Ears / Antenna Side Plugs
    ctx.save();
    ctx.lineWidth = 3.5 * scale;
    ctx.strokeStyle = '#181e29';
    ctx.fillStyle = '#b5bdc9';
    // left ear plug
    ctx.beginPath();
    ctx.roundRect(rx - 43 * scale, ry - 41 * scale, 8 * scale, 16 * scale, 4 * scale);
    ctx.fill();
    ctx.stroke();
    // right ear plug
    ctx.beginPath();
    ctx.roundRect(rx + 35 * scale, ry - 41 * scale, 8 * scale, 16 * scale, 4 * scale);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // 6. Draw Head (Rounded Helmet)
    ctx.save();
    const headY = ry - 32 * scale;
    ctx.lineWidth = 3.5 * scale;
    ctx.strokeStyle = '#181e29';
    
    const headGrad = ctx.createLinearGradient(rx - 38 * scale, headY - 26 * scale, rx + 38 * scale, headY + 26 * scale);
    headGrad.addColorStop(0, '#ffffff');
    headGrad.addColorStop(0.3, '#f5f7fa');
    headGrad.addColorStop(1, '#b5bdc9');
    ctx.fillStyle = headGrad;

    ctx.beginPath();
    ctx.roundRect(rx - 38 * scale, headY - 23 * scale, 76 * scale, 46 * scale, 21 * scale);
    ctx.fill();
    ctx.stroke();

    // Inner Glass Screen
    ctx.fillStyle = '#0f1726'; // Glossy dark navy screen
    ctx.beginPath();
    ctx.roundRect(rx - 30 * scale, headY - 17 * scale, 60 * scale, 34 * scale, 13 * scale);
    ctx.fill();
    ctx.stroke();

    // Glowing Cyan Eyes
    ctx.fillStyle = accentColor;
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = 8;
    
    // Left eye (semi-circle smile shape)
    ctx.beginPath();
    ctx.arc(rx - 12 * scale, headY - 2 * scale, 4.5 * scale, Math.PI, 0);
    ctx.fill();

    // Right eye
    ctx.beginPath();
    ctx.arc(rx + 12 * scale, headY - 2 * scale, 4.5 * scale, Math.PI, 0);
    ctx.fill();

    // Little talking/smiling mouth
    ctx.beginPath();
    if (isTalking) {
      const openAmount = 3.5 * scale + Math.sin(time * 0.3) * 1.5 * scale;
      ctx.ellipse(rx, headY + 5.5 * scale, 4 * scale, openAmount, 0, 0, Math.PI * 2);
    } else {
      ctx.arc(rx, headY + 5 * scale, 3.2 * scale, 0, Math.PI);
    }
    ctx.fill();

    ctx.restore();
    ctx.restore();
  };

  // Synchronize canvas size on resize using ResizeObserver to prevent canvas stretching
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    if (typeof ResizeObserver === 'undefined') {
      // Fallback for jsdom testing environments
      const resize = () => {
        canvas.width = parent.clientWidth;
        canvas.height = parent.clientHeight;
      };
      resize();
      window.addEventListener('resize', resize);
      return () => {
        window.removeEventListener('resize', resize);
      };
    }

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        // Fall back to clientWidth/clientHeight if entry contentRect is zero/unpopulated
        canvas.width = width || parent.clientWidth;
        canvas.height = height || parent.clientHeight;
      }
    });

    resizeObserver.observe(parent);

    if (stars.current.length === 0) {
      for (let i = 0; i < 70; i++) {
        stars.current.push({
          x: (Math.random() - 0.5) * 800,
          y: (Math.random() - 0.5) * 450,
          z: Math.random() * 600 + 50,
          color: Math.random() > 0.65 ? 'rgba(94, 210, 156, 0.25)' : 'rgba(255, 255, 255, 0.12)'
        });
      }
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [isEnclaveActive]);

  // requestAnimationFrame rendering loop
  useEffect(() => {
    let animationFrameId: number;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let time = 0;

    const loop = () => {
      time += 1;
      const w = canvas.width;
      const h = canvas.height;
      if (w === 0 || h === 0) {
        animationFrameId = requestAnimationFrame(loop);
        return;
      }
      ctx.clearRect(0, 0, w, h);

      // Background Cyberpunk Radial Space
      const radial = ctx.createRadialGradient(w/2, h/2, 20, w/2, h/2, Math.max(w, h));
      radial.addColorStop(0, '#090b14');
      radial.addColorStop(0.7, '#040509');
      radial.addColorStop(1, '#020204');
      ctx.fillStyle = radial;
      ctx.fillRect(0, 0, w, h);

      // 3D Matrix particle field
      const fov = 200;
      const cx = w / 2;
      const cy = h / 2;
      stars.current.forEach(star => {
        star.z -= 1.2;
        if (star.z <= 0) {
          star.z = 650;
          star.x = (Math.random() - 0.5) * w * 1.5;
          star.y = (Math.random() - 0.5) * h * 1.5;
        }

        const scale = fov / star.z;
        const sx = cx + star.x * scale;
        const sy = cy + star.y * scale;

        if (sx >= 0 && sx <= w && sy >= 0 && sy <= h) {
          const size = Math.max(0.5, scale * 3);
          const opacity = Math.min(1.0, (650 - star.z) / 100) * 0.45;
          ctx.fillStyle = star.color.replace(/[\d.]+\)$/, `${opacity})`);
          ctx.beginPath();
          ctx.arc(sx, sy, size, 0, Math.PI * 2);
          ctx.fill();
        }
      });

      // Receding Synthwave floor grid
      ctx.save();
      ctx.strokeStyle = 'rgba(94, 210, 156, 0.05)';
      ctx.lineWidth = 1;
      const horizon = h * 0.45;
      
      const numLines = 14;
      for (let i = 0; i <= numLines; i++) {
        const xRatio = i / numLines;
        const startX = w * -0.2 + (w * 1.4) * xRatio;
        ctx.beginPath();
        ctx.moveTo(w / 2 + (startX - w / 2) * 0.08, horizon);
        ctx.lineTo(startX, h);
        ctx.stroke();
      }

      const gridSpeed = 1.6;
      const gridSpacing = 42;
      const offset = (time * gridSpeed) % gridSpacing;
      for (let y = horizon; y <= h; y += gridSpacing) {
        const currentY = y + offset;
        if (currentY > h) continue;
        ctx.beginPath();
        ctx.moveTo(0, currentY);
        ctx.lineTo(w, currentY);
        ctx.stroke();
      }
      ctx.restore();

      // State determination for local robot walking / standing
      const localStandingX = w * 0.22;
      const peerStandingX = w * 0.78;
      let localIsWalking: boolean;

      if (activeStage < 4) {
        localIsWalking = true;
        const localTargetX = w * 0.22;
        localPos.current.x += (localTargetX - localPos.current.x) * 0.05;
      } else {
        const dist = Math.abs(localPos.current.x - localStandingX);
        if (dist > 6) {
          localPos.current.x += (localStandingX - localPos.current.x) * 0.035;
          localIsWalking = true;
        } else {
          localIsWalking = false;
        }
      }

      // State determination for peer robot walking / standing
      let peerIsWalking = false;

      const targetOpacity = activeStage >= 4 ? 1.0 : 0.0;
      peerOpacity.current += (targetOpacity - peerOpacity.current) * 0.04;

      if (activeStage >= 4) {
        if (peerPos.current.x > w * 0.95) {
          peerPos.current.x = w * 0.95;
        }
        const dist = Math.abs(peerPos.current.x - peerStandingX);
        if (dist > 6) {
          peerPos.current.x += (peerStandingX - peerPos.current.x) * 0.05;
          peerIsWalking = true;
        } else {
          peerIsWalking = false;
        }
      } else {
        peerPos.current.x = w + 100;
      }

      // Center TEE Hub coordinate bob
      const hubTargetX = w / 2;
      const hubTargetY = h / 2 - 20 + Math.sin(time * 0.02) * 12;
      hubPos.current.x += (hubTargetX - hubPos.current.x) * 0.06;
      hubPos.current.y += (hubTargetY - hubPos.current.y) * 0.06;

      // Draw local scanning cones/radar pings (searching phase)
      if (activeStage > 0 && activeStage < 4) {
        ctx.save();
        for (let r = 0; r < 3; r++) {
          const radius = (time * 0.75 + r * 60) % 180;
          const op = Math.max(0, 1 - radius / 180) * 0.25;
          ctx.strokeStyle = `rgba(94, 210, 156, ${op})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(localPos.current.x, localPos.current.y - 15, radius, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }

      // Draw Connection lines & flowing packet signals
      if (activeStage >= 1) {
        // Local to Hub link
        ctx.save();
        ctx.strokeStyle = 'rgba(94, 210, 156, 0.18)';
        ctx.lineWidth = 1.8;
        ctx.setLineDash([4, 6]);
        ctx.lineDashOffset = -time * 0.4;
        ctx.beginPath();
        ctx.moveTo(localPos.current.x, localPos.current.y - 15);
        ctx.lineTo(hubPos.current.x, hubPos.current.y);
        ctx.stroke();
        ctx.restore();

        // Glowing packets
        ctx.fillStyle = 'rgba(94, 210, 156, 0.9)';
        const packets = 3;
        for (let p = 0; p < packets; p++) {
          const offset = (time * 0.0025 + p / packets) % 1.0;
          const px = localPos.current.x + (hubPos.current.x - localPos.current.x) * offset;
          const py = localPos.current.y - 15 + (hubPos.current.y - (localPos.current.y - 15)) * offset;
          ctx.beginPath();
          ctx.arc(px, py, 3.5, 0, Math.PI * 2);
          ctx.shadowColor = 'rgba(94, 210, 156, 0.8)';
          ctx.shadowBlur = 10;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }

      if (peerOpacity.current > 0.02) {
        // Peer to Hub link
        ctx.save();
        ctx.strokeStyle = `rgba(245, 158, 11, ${peerOpacity.current * 0.18})`;
        ctx.lineWidth = 1.8;
        ctx.setLineDash([4, 6]);
        ctx.lineDashOffset = time * 0.4;
        ctx.beginPath();
        ctx.moveTo(peerPos.current.x, peerPos.current.y - 15);
        ctx.lineTo(hubPos.current.x, hubPos.current.y);
        ctx.stroke();
        ctx.restore();

        // Glowing peer packets
        ctx.fillStyle = `rgba(245, 158, 11, ${peerOpacity.current})`;
        const packets = 3;
        for (let p = 0; p < packets; p++) {
          const offset = (time * 0.0025 + p / packets) % 1.0;
          const px = peerPos.current.x + (hubPos.current.x - peerPos.current.x) * offset;
          const py = peerPos.current.y - 15 + (hubPos.current.y - (peerPos.current.y - 15)) * offset;
          ctx.beginPath();
          ctx.arc(px, py, 3.5, 0, Math.PI * 2);
          ctx.shadowColor = 'rgba(245, 158, 11, 0.8)';
          ctx.shadowBlur = 10;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }

      // Draw the Cute Robots matching the user design
      const robotScale = isTheaterMode ? (h / 380) : (h / 230);
      
      // Local Robot
      drawCuteRobot(
        ctx,
        localPos.current.x,
        localPos.current.y + (isTheaterMode ? 10 : 0),
        robotScale,
        '#5ed29c',
        time,
        localIsWalking,
        latestLocalBubble !== null
      );

      // Peer Robot
      if (peerOpacity.current > 0.02) {
        ctx.save();
        ctx.globalAlpha = peerOpacity.current;
        drawCuteRobot(
          ctx,
          peerPos.current.x,
          peerPos.current.y + (isTheaterMode ? 10 : 0),
          robotScale,
          '#F59E0B',
          time,
          peerIsWalking,
          latestPeerBubble !== null
        );
        ctx.restore();
      }

      // Sync positions of HTML overlays
      if (localNodeRef.current) {
        localNodeRef.current.style.transform = `translate3d(${localPos.current.x}px, ${localPos.current.y - 15}px, 0)`;
      }
      if (hubNodeRef.current) {
        hubNodeRef.current.style.transform = `translate3d(${hubPos.current.x}px, ${hubPos.current.y}px, 0)`;
      }
      if (peerNodeRef.current) {
        peerNodeRef.current.style.transform = `translate3d(${peerPos.current.x}px, ${peerPos.current.y - 15}px, 0)`;
        peerNodeRef.current.style.opacity = `${peerOpacity.current}`;
        peerNodeRef.current.style.pointerEvents = activeStage >= 4 ? 'auto' : 'none';
      }

      animationFrameId = requestAnimationFrame(loop);
    };

    loop();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [activeStage, latestLocalBubble, latestPeerBubble, compact, isTheaterMode, isEnclaveActive]);

  const handleClearDialogue = () => {
    setMessages([]);
  };



  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)', flex: 1, minHeight: 0 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Share+Tech+Mono&display=swap');

        body.theater-mode-enabled {
          overflow: hidden !important;
        }

        body.theater-mode-enabled,
        body.theater-mode-enabled .dashboard-v2-container,
        body.theater-mode-enabled .dashboard-container-v3,
        body.theater-mode-enabled .main-content,
        body.theater-mode-enabled .dashboard-grid-overview,
        body.theater-mode-enabled .layout-col-2 {
          transform: none !important;
          animation: none !important;
          filter: none !important;
          backdrop-filter: none !important;
          perspective: none !important;
          will-change: auto !important;
        }

        body.theater-mode-enabled .sidebar {
          display: none !important;
        }

        body.theater-mode-enabled .main-content {
          padding: 0 !important;
          margin: 0 !important;
          width: 100vw !important;
          max-width: 100vw !important;
          height: 100vh !important;
          overflow: hidden !important;
        }

        body.theater-mode-enabled .dashboard-header,
        body.theater-mode-enabled .layout-metrics,
        body.theater-mode-enabled .dashboard-v2-container > .overlay-left-to-right,
        body.theater-mode-enabled .dashboard-v2-container > .overlay-bottom-up,
        body.theater-mode-enabled .central-glow-svg {
          display: none !important;
        }

        body.theater-mode-enabled .dashboard-grid-overview {
          display: block !important;
          margin: 0 !important;
          padding: 0 !important;
          width: 100vw !important;
          height: 100vh !important;
        }

        body.theater-mode-enabled .dashboard-grid-overview > .layout-col-1 {
          display: none !important;
        }

        body.theater-mode-enabled .dashboard-grid-overview > .layout-col-2 {
          display: block !important;
          margin: 0 !important;
          padding: 0 !important;
          width: 100vw !important;
          height: 100vh !important;
        }

        body.theater-mode-enabled .match-arena-card-3d {
          position: fixed !important;
          inset: 0 !important;
          left: 0 !important;
          top: 0 !important;
          width: 100vw !important;
          height: 100vh !important;
          z-index: 99999999 !important;
          border: none !important;
          border-radius: 0 !important;
          padding: 0 !important;
          margin: 0 !important;
          background: #000 !important;
        }

        .match-arena-card-3d {
          display: flex;
          flex-direction: column;
          gap: var(--spacing-md);
          flex: 1;
          position: relative;
          overflow: hidden;
          transition: all var(--transition-normal);
        }

        /* Full page theater mode overrides covering sidebar completely */
        .match-arena-card-3d.theater-active {
          position: fixed;
          inset: 0 !important;
          left: 0 !important;
          top: 0 !important;
          width: 100vw !important;
          height: 100vh !important;
          z-index: 999999 !important;
          border-radius: 0;
          border: none;
          padding: 0;
          background: #000;
        }

        .match-diagram-container-3d {
          position: relative;
          height: 250px;
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          overflow: hidden;
          background: #020305;
          transition: height 0.3s ease;
        }

        .compact-diagram-3d {
          height: 210px;
        }

        .theater-active .match-diagram-container-3d {
          height: 100vh !important;
          width: 100vw !important;
          border-radius: 0;
          border: none;
        }

        /* Hide all timeline steps and panels when in full page overlay */
        .theater-active .stage-pipeline-3d,
        .theater-active .strategy-scope-container-3d {
          display: none !important;
        }

        /* CRT monitor scanlines effect */
        .match-diagram-container-3d::after {
          content: " ";
          display: block;
          position: absolute;
          inset: 0;
          background: linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.25) 50%);
          z-index: 10;
          background-size: 100% 4px;
          pointer-events: none;
          opacity: 0.35;
        }

        .void-canvas {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          z-index: 1;
        }

        /* 3D Floating Node Overlays */
        .node-layer-3d {
          position: absolute;
          inset: 0;
          z-index: 2;
          pointer-events: none;
        }

        .node-3d {
          position: absolute;
          width: 72px;
          height: 72px;
          margin-left: -36px;
          margin-top: -36px;
          border-radius: 50%;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          pointer-events: auto;
          cursor: pointer;
        }

        /* TEE core remains an HTML hologram */
        .node-3d.hub {
          background: radial-gradient(circle, rgba(94, 210, 156, 0.1) 0%, rgba(0, 0, 0, 0.85) 75%);
          border: 1.5px solid var(--color-accent);
          box-shadow: 0 0 20px rgba(var(--color-accent-rgb), 0.25), inset 0 0 10px rgba(var(--color-accent-rgb), 0.15);
        }

        /* Holographic Orbits */
        .orbit-spin-3d {
          position: absolute;
          inset: -6px;
          border: 1px dashed rgba(var(--color-accent-rgb), 0.35);
          border-radius: 50%;
          animation: spin 6s linear infinite;
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        .node-icon-3d {
          color: var(--color-accent);
          filter: drop-shadow(0 0 4px currentColor);
        }

        /* Node HUD tags */
        .node-hud-tag {
          position: absolute;
          bottom: -46px;
          text-align: center;
          font-family: var(--font-mono), monospace;
          font-size: 0.55rem;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          width: 140px;
        }
        .local-tag { color: var(--color-accent); text-shadow: 0 0 4px rgba(var(--color-accent-rgb),0.4); }
        .peer-tag { color: var(--color-warning); text-shadow: 0 0 4px rgba(245, 158, 11,0.4); }
        .hub-tag { color: var(--color-accent); text-shadow: 0 0 4px rgba(var(--color-accent-rgb),0.4); }

        .node-hud-tag strong {
          display: block;
          font-size: 0.6rem;
          font-weight: 700;
        }
        .node-hud-tag span {
          opacity: 0.7;
        }

        /* Floating Hologram Speech Bubbles */
        .hologram-bubble {
          position: absolute;
          bottom: 74px; /* sits nicely above the robot head */
          left: 50%;
          transform: translate(-50%, 0);
          background: rgba(11, 15, 25, 0.94);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border: 1px solid var(--color-accent);
          color: #fff;
          font-family: var(--font-mono), monospace;
          font-size: 0.65rem;
          padding: 8px 12px;
          border-radius: 6px;
          box-shadow: 0 0 20px rgba(var(--color-accent-rgb), 0.25), inset 0 0 10px rgba(var(--color-accent-rgb), 0.1);
          width: max-content;
          max-width: 220px;
          text-align: center;
          white-space: normal;
          word-break: break-word;
          z-index: 100;
          pointer-events: none;
          animation: bubblePulse 0.3s ease-out forwards, bubbleFloat 4s ease-in-out infinite;
        }

        .theater-active .hologram-bubble {
          bottom: 125px; /* offset more in theater mode because robot is bigger */
          font-size: 0.85rem;
          max-width: 320px;
          padding: 12px 18px;
        }

        .hologram-bubble::after {
          content: '';
          position: absolute;
          bottom: -6px;
          left: 50%;
          transform: translateX(-50%);
          border-width: 6px 6px 0;
          border-style: solid;
          border-color: var(--color-accent) transparent;
          display: block;
          width: 0;
        }

        .hologram-bubble.peer-bubble {
          border-color: var(--color-warning);
          box-shadow: 0 0 20px rgba(245, 158, 11, 0.25), inset 0 0 10px rgba(245, 158, 11, 0.1);
        }
        .hologram-bubble.peer-bubble::after {
          border-color: var(--color-warning) transparent;
        }

        .hologram-bubble.hub-bubble {
          border-color: var(--color-accent);
          box-shadow: 0 0 20px rgba(var(--color-accent-rgb), 0.25), inset 0 0 10px rgba(var(--color-accent-rgb), 0.1);
          bottom: 84px; /* higher offset for Hub circle */
        }
        
        .theater-active .hologram-bubble.hub-bubble {
          bottom: 125px;
        }

        .hologram-bubble.hub-bubble::after {
          border-color: var(--color-accent) transparent;
        }

        @keyframes bubblePulse {
          from { opacity: 0; transform: translate(-50%, 8px) scale(0.95); }
          to { opacity: 1; transform: translate(-50%, 0) scale(1); }
        }

        @keyframes bubbleFloat {
          0%, 100% { margin-bottom: 0px; }
          50% { margin-bottom: 4px; }
        }

        /* Theater overlay specific close and indicator HUD */
        .theater-close-btn {
          position: absolute;
          top: 24px;
          right: 24px;
          z-index: 9999999;
          background: rgba(245, 158, 11, 0.12);
          border: 1.5px solid var(--color-warning);
          border-radius: 6px;
          color: var(--color-warning);
          font-family: var(--font-mono), monospace;
          font-size: 0.75rem;
          letter-spacing: 0.05em;
          padding: 8px 18px;
          cursor: pointer;
          text-shadow: 0 0 5px rgba(245, 158, 11, 0.5);
          box-shadow: 0 0 15px rgba(245, 158, 11, 0.2);
          transition: all 0.2s;
        }
        .theater-close-btn:hover {
          background: rgba(245, 158, 11, 0.25);
          box-shadow: 0 0 22px rgba(245, 158, 11, 0.45);
        }

        .theater-status-hud {
          position: absolute;
          top: 24px;
          left: 24px;
          z-index: 9999999;
          color: var(--color-accent);
          font-family: var(--font-display), sans-serif;
          font-size: 0.8rem;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-shadow: 0 0 10px rgba(var(--color-accent-rgb), 0.4);
          text-transform: uppercase;
        }

        /* 6-Stage Progress Pipeline HUD */
        .stage-pipeline-3d {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px var(--spacing-sm);
          background: var(--color-input-bg);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          margin-top: 4px;
        }

        .stage-node-item-3d {
          display: flex;
          flex-direction: column;
          align-items: center;
          flex: 1;
          position: relative;
        }

        .stage-node-item-3d:not(:last-child)::after {
          content: '';
          position: absolute;
          top: 13px;
          left: 50%;
          width: 100%;
          height: 1px;
          background: var(--color-border);
          z-index: 1;
        }

        .stage-node-item-3d.completed:not(:last-child)::after {
          background: linear-gradient(90deg, var(--color-accent), var(--color-border));
        }

        .stage-circle-3d {
          width: 26px;
          height: 26px;
          border-radius: 50%;
          background: var(--color-bg);
          border: 1px solid var(--color-border);
          color: var(--color-text-muted);
          font-family: var(--font-mono), monospace;
          font-size: 0.65rem;
          font-weight: 700;
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          z-index: 2;
          transition: all 0.3s ease;
        }

        .stage-node-item-3d.active .stage-circle-3d {
          border-color: var(--color-accent);
          color: var(--color-accent);
          box-shadow: 0 0 10px rgba(var(--color-accent-rgb), 0.4);
        }

        .stage-node-item-3d.completed .stage-circle-3d {
          border-color: var(--color-accent);
          background: rgba(var(--color-accent-rgb), 0.15);
          color: var(--color-accent);
        }

        .stage-label-text-3d {
          font-family: var(--font-mono), monospace;
          font-size: 0.58rem;
          letter-spacing: 0.05em;
          color: var(--color-text-muted);
          margin-top: 6px;
          text-transform: uppercase;
        }

        .stage-node-item-3d.active .stage-label-text-3d {
          color: var(--color-accent);
        }

        /* 3D Scope & Dialogue Details */
        .strategy-scope-container-3d {
          display: flex;
          flex-direction: column;
          gap: var(--spacing-md);
        }

        .compact-scope-3d {
          grid-template-columns: 1fr;
          min-height: 0;
        }

        .oscilloscope-box-3d {
          border: 1px solid var(--color-border);
          background: var(--color-input-bg);
          border-radius: var(--radius-md);
          position: relative;
          height: 140px;
          overflow: hidden;
          display: flex;
          align-items: flex-end;
          padding: 8px;
        }

        .oscilloscope-label-3d {
          position: absolute;
          top: 6px;
          left: 8px;
          font-family: var(--font-mono), monospace;
          font-size: 0.55rem;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          color: rgba(var(--color-accent-rgb), 0.6);
          z-index: 2;
        }

        /* Scrolling dialogue logs CRT style */
        .dialogue-stream-3d {
          border: 1px solid var(--color-border);
          background: var(--color-input-bg);
          border-radius: var(--radius-md);
          padding: 10px;
          height: 160px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 6px;
          position: relative;
        }

        .dialogue-stream-3d::-webkit-scrollbar {
          width: 4px;
        }
        .dialogue-stream-3d::-webkit-scrollbar-thumb {
          background: var(--color-border);
          border-radius: 2px;
        }
        .dialogue-stream-3d::-webkit-scrollbar-thumb:hover {
          background: var(--color-accent);
        }

        .dialogue-bubble-3d {
          border-left: 2px solid var(--color-border);
          padding-left: 8px;
          margin-bottom: 2px;
          font-family: var(--font-mono), monospace;
          font-size: 0.65rem;
          color: var(--color-text-primary);
        }

        .dialogue-bubble-3d.system {
          border-color: var(--color-accent);
          color: rgba(var(--color-accent-rgb), 0.95);
        }

        .dialogue-bubble-3d.agent {
          border-color: var(--color-accent);
          color: rgba(var(--color-accent-rgb), 0.95);
        }

        .dialogue-bubble-3d.peer {
          border-color: var(--color-warning);
          color: rgba(245, 158, 11, 0.95);
        }

        .dialogue-header-3d {
          display: flex;
          justify-content: space-between;
          font-size: 0.58rem;
          opacity: 0.6;
          margin-bottom: 2px;
          text-transform: uppercase;
        }

        .dialogue-body-3d {
          line-height: 1.35;
        }
      `}</style>

      <div className={`card match-arena-card-3d ${isTheaterMode ? 'theater-active' : ''}`}>
        <h2 className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Shield01Icon size={18} style={{ color: 'var(--color-accent)' }} /> SECURE CRYPTOGRAPHIC WORKSPACE
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {isEnclaveActive ? (
              <span className="status-badge secure" style={{ fontSize: '0.65rem', padding: '2px 8px', textShadow: 'none' }}>
                <span className="pulse-dot" style={{ width: '6px', height: '6px', backgroundColor: 'var(--color-success)' }} /> ACTIVE
              </span>
            ) : (
              <span className="status-badge" style={{ fontSize: '0.65rem', padding: '2px 8px', color: 'var(--color-text-muted)', border: '1px solid var(--color-border)', background: 'rgba(255,255,255,0.02)', textShadow: 'none' }}>
                OFFLINE
              </span>
            )}
          </div>
        </h2>

        {!isEnclaveActive ? (
          <div style={{ display: 'flex', flex: 1, minHeight: '250px', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '8px', border: '1px dashed var(--color-border)', borderRadius: 'var(--radius-md)' }}>
            <CpuIcon size={32} style={{ color: 'var(--color-text-muted)', animation: 'pulse 2s infinite' }} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--color-text-muted)', letterSpacing: '0.05em' }}>
              Awaiting agent connections...
            </span>
          </div>
        ) : (
          <>
            {/* 1. 3D Space Void Diagram */}
            <div className={`match-diagram-container-3d ${compact && !isTheaterMode ? 'compact-diagram-3d' : ''}`}>
              <canvas ref={canvasRef} className="void-canvas" />

              <div className="node-layer-3d">
                {/* Node 1: Local Agent Overlay */}
                <div 
                  ref={localNodeRef}
                  className="node-3d" 
                >
                  <div className="node-hud-tag local-tag">
                    <strong>{institutionName}</strong>
                    <span>{localAgent ? truncateDid(localAgent.agentDid) : 'did:pending'}</span>
                  </div>

                  {latestLocalBubble && (
                    <div className="hologram-bubble">
                      {latestLocalBubble}
                    </div>
                  )}
                </div>

                {/* Node 2: TEE Hub */}
                <div 
                  ref={hubNodeRef}
                  className="node-3d hub"
                  style={{ display: isTheaterMode ? 'none' : 'flex' }} // Hide TEE hub center circle in clean theater mode
                >
                  <div className="orbit-spin-3d" />
                  <CpuIcon className="node-icon-3d" size={24} />
                  <div className="node-hud-tag hub-tag">
                    <strong>{activeStage === 6 ? 'PURGED' : activeStage === 5 ? 'SETTLING' : activeStage >= 2 ? 'EVALUATING' : 'SECURE'}</strong>
                    <span>GHOSTBROKER TEE</span>
                  </div>

                  {latestHubBubble && (
                    <div className="hologram-bubble hub-bubble">
                      {latestHubBubble}
                    </div>
                  )}
                </div>

                {/* Node 3: Counterparty Agent Overlay */}
                <div 
                  ref={peerNodeRef}
                  className="node-3d"
                >
                  <div className="node-hud-tag peer-tag">
                    <strong>{counterpartyAgent ? getCounterpartyHandle(counterpartyAgent.agentDid) : 'Counterparty'}</strong>
                    <span>{counterpartyAgent ? truncateDid(counterpartyAgent.agentDid) : 'did:t3:confidential...'}</span>
                  </div>

                  {latestPeerBubble && (
                    <div className="hologram-bubble peer-bubble">
                      {latestPeerBubble}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* 2. Pipeline Steps Timeline */}
            <div className="stage-pipeline-3d">
              {[
                { step: 1, label: 'Attest' },
                { step: 2, label: 'Blind' },
                { step: 3, label: 'Pair' },
                { step: 4, label: 'Negotiate' },
                { step: 5, label: 'Settle' },
                { step: 6, label: 'Purge' }
              ].map((item) => {
                const isActive = activeStage === item.step;
                const isCompleted = activeStage > item.step;
                return (
                  <div key={item.step} className={`stage-node-item-3d ${isActive ? 'active' : ''} ${isCompleted ? 'completed' : ''}`}>
                    <div className="stage-circle-3d">
                      {isCompleted ? '✓' : item.step}
                    </div>
                    <span className="stage-label-text-3d">{item.label}</span>
                  </div>
                );
              })}
            </div>

            {/* 3. Detail Views (Dialogues Only) */}
            <div className={`strategy-scope-container-3d ${compact && !isTheaterMode ? 'compact-scope-3d' : ''}`}>
              {/* Dialogue Box showing secure event updates */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', width: '100%' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Secure Enclave Dialogue Transcript</span>
                  {messages.length > 0 && (
                    <button 
                      type="button" 
                      onClick={handleClearDialogue}
                      style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: '0.58rem', letterSpacing: '0.05em' }}
                    >
                      CLEAR
                    </button>
                  )}
                </div>
                <div className="dialogue-stream-3d">
                  {messages.length === 0 ? (
                    <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', fontSize: '0.65rem' }}>
                      No dialogue logs generated.
                    </div>
                  ) : (
                    messages.map((msg) => {
                      const isSys = msg.isSystem;
                      const isPeer = msg.sender.toLowerCase().includes('counterparty') || msg.sender.toLowerCase().includes('sachs') || msg.sender.toLowerCase().includes('morgan') || msg.sender.toLowerCase().includes('citibank') || msg.sender.toLowerCase().includes('jpmorgan');
                      
                      return (
                        <div key={msg.id} className={`dialogue-bubble-3d ${isSys ? 'system' : isPeer ? 'peer' : 'agent'}`}>
                          <div className="dialogue-header-3d">
                            <span>{msg.sender}</span>
                            <span>{msg.time}</span>
                          </div>
                          <div className="dialogue-body-3d">
                            {msg.message}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default TeeNegotiationVisualizer;
