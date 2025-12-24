import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { database } from './firebase';
import { ref, onValue, set, push, off, serverTimestamp } from 'firebase/database';
import { topics, type TopicId, getRandomPlayerForTopic } from './topics';
import type {
  CluePayload,
  GameClue,
  GamePhase,
  GameState,
  LeavePayload,
  PlayerState,
  ReadyPayload,
  VotePayload,
} from './types';

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 6;

const generateRoomCode = () => {
  const letter = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)];
  const num1 = Math.floor(Math.random() * 10);
  const num2 = Math.floor(Math.random() * 10);
  return `${letter}${num1}${num2}`;
};

const sanitizeName = (raw: string) => raw.trim().slice(0, 18);

const sanitizeWord = (raw: string) => raw.trim().slice(0, 30);

const getAlivePlayers = (state: GameState) => state.players.filter((p) => p.alive);

const getPlayerOrder = (state: GameState): PlayerState[] => {
  if (state.firstSpeakerIndex === undefined || state.firstSpeakerIndex < 0 || state.firstSpeakerIndex >= state.players.length) {
    // Si no hay firstSpeakerIndex, devolver jugadores en el orden del array (orden de llegada)
    return state.players;
  }
  
  // Usar el mismo orden que nextSpeakerIndex: array original (orden de llegada) empezando desde firstSpeakerIndex
  // Esto garantiza que el orden visual sea el mismo que el orden real de turnos
  const ordered: PlayerState[] = [];
  const startIndex = state.firstSpeakerIndex;
  
  // Empezar desde firstSpeakerIndex y seguir el orden circular del array original
  // Este es el orden fijo que se establece al inicio de la partida
  for (let i = 0; i < state.players.length; i++) {
    const index = (startIndex + i) % state.players.length;
    if (state.players[index]) {
      ordered.push(state.players[index]);
    }
  }
  
  return ordered;
};

const cluesForRound = (clues: GameClue[] | undefined, round: number) => {
  if (!clues || !Array.isArray(clues)) return [];
  return clues.filter((item) => item.round === round);
};

const hasGivenClueThisRound = (state: GameState, playerId: string) => {
  const clues = cluesForRound(state.clues, state.round);
  return clues.some((clue) => clue.playerId === playerId);
};

const nextSpeakerIndex = (state: GameState): number => {
  const alivePlayers = getAlivePlayers(state);
  const clues = cluesForRound(state.clues, state.round);
  const alreadySpoke = clues.map((clue) => clue.playerId);

  if (alivePlayers.length === 0) {
    return -1;
  }

  if (alreadySpoke.length >= alivePlayers.length) {
    return -1;
  }

  // Si currentTurnIndex es -1 (inicio de ronda), usar firstSpeakerIndex si existe
  // Si no hay firstSpeakerIndex, usar el primer jugador vivo
  // Si currentTurnIndex >= 0, avanzar desde ahí
  let startIndex: number = state.currentTurnIndex;
  
  if (state.currentTurnIndex < 0) {
    if (state.firstSpeakerIndex !== undefined) {
      // Si el primer jugador sigue vivo, usarlo
      if (state.players[state.firstSpeakerIndex]?.alive) {
        startIndex = state.firstSpeakerIndex;
      } else {
        // Si el primer jugador fue eliminado, encontrar el siguiente vivo desde ese índice
        let searchIndex = state.firstSpeakerIndex;
        let found = false;
        for (let i = 0; i < state.players.length; i++) {
          const candidate = state.players[searchIndex];
          if (candidate && candidate.alive) {
            startIndex = searchIndex;
            found = true;
            break;
          }
          searchIndex = (searchIndex + 1) % state.players.length;
        }
        if (!found) {
          startIndex = state.players.findIndex((p) => p.alive);
        }
      }
    } else {
      // No hay firstSpeakerIndex, usar el primer jugador vivo
      startIndex = state.players.findIndex((p) => p.alive);
    }
  }

  let attempts = 0;
  let candidateIndex = startIndex;

  while (attempts < state.players.length) {
    // Si es el primer intento, usar el índice actual, si no, avanzar al siguiente en orden
    if (attempts === 0) {
      candidateIndex = startIndex;
    } else {
      // Avanzar al siguiente jugador en el orden del array (orden de llegada)
      candidateIndex = (candidateIndex + 1) % state.players.length;
    }
    const candidate = state.players[candidateIndex];
    if (candidate && candidate.alive && !alreadySpoke.includes(candidate.id)) {
      return candidateIndex;
    }
    attempts += 1;
  }

  return -1;
};

const tallyVotes = (votes: Record<string, string>) => {
  const tally: Record<string, number> = {};
  Object.values(votes).forEach((targetId) => {
    tally[targetId] = (tally[targetId] ?? 0) + 1;
  });
  return tally;
};

const resolveVotes = (state: GameState) => {
  const tally = tallyVotes(state.votes);
  const entries = Object.entries(tally);
  if (entries.length === 0) {
    return { targetId: null, tie: false, tiedPlayers: [], voteCount: 0 } as const;
  }

  entries.sort(([, a], [, b]) => b - a);
  const [topTargetId, topVotes] = entries[0];
  const isTie = entries.length > 1 && entries[1][1] === topVotes;
  
  // Si hay empate, obtener todos los jugadores empatados
  const tiedPlayers: string[] = [];
  if (isTie) {
    entries.forEach(([playerId, votes]) => {
      if (votes === topVotes) {
        tiedPlayers.push(playerId);
      }
    });
  }
  
  return { 
    targetId: isTie ? null : topTargetId, 
    tie: isTie,
    tiedPlayers,
    voteCount: topVotes
  } as const;
};

const usePersistentState = (key: string, defaultValue: string) => {
  const [value, setValue] = useState(() => window.localStorage.getItem(key) ?? defaultValue);

  useEffect(() => {
    window.localStorage.setItem(key, value);
  }, [key, value]);

  return [value, setValue] as const;
};

const App = () => {
  const [playerName, setPlayerName] = usePersistentState('impostor-player-name', '');
  const [isMounted, setIsMounted] = useState(false);
  
  // Generar un ID único por sesión/pestaña (permite múltiples pestañas en localhost)
  const [playerId] = useState(() => {
    // Usar sessionStorage en lugar de localStorage para permitir múltiples pestañas
    const stored = window.sessionStorage.getItem('impostor-player-id');
    if (stored) return stored;
    const fresh = crypto.randomUUID();
    window.sessionStorage.setItem('impostor-player-id', fresh);
    return fresh;
  });

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [channelReady, setChannelReady] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState<TopicId | null>(null);
  const [showClueOption, setShowClueOption] = useState<boolean>(true);
  const [allowVoteChangeOption, setAllowVoteChangeOption] = useState<boolean>(true);
  const [singleWordOnlyOption, setSingleWordOnlyOption] = useState<boolean>(false);
  const [voteDisplayModeOption, setVoteDisplayModeOption] = useState<'hidden' | 'count' | 'visible'>('visible');
  const [selectedTimeLimit, setSelectedTimeLimit] = useState<number | undefined>(undefined);
  const [selectedVotingTimeLimit, setSelectedVotingTimeLimit] = useState<number | undefined>(undefined);
  const [activeTimeTab, setActiveTimeTab] = useState<'turno' | 'votaciones' | null>(null);
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [clueInput, setClueInput] = useState('');
  const clueInputRef = useRef<string>('');
  const [countdown, setCountdown] = useState<number | null>(null);
  const [turnTimeRemaining, setTurnTimeRemaining] = useState<number | null>(null);
  const [votingTimeRemaining, setVotingTimeRemaining] = useState<number | null>(null);
  const [revealCountdown, setRevealCountdown] = useState<number | null>(null);
  
  // Estados para modo local (un solo dispositivo)
  const [isLocalMode, setIsLocalMode] = useState(false);
  const [localPlayers, setLocalPlayers] = useState<string[]>([]);
  const [localPlayerInput, setLocalPlayerInput] = useState('');
  const [currentLocalPlayerIndex, setCurrentLocalPlayerIndex] = useState(0);
  const [localGameState, setLocalGameState] = useState<{
    topic: string;
    secretWord: string;
    selectedPlayerClue?: string;
    showClue: boolean;
    impostorId: string;
    players: Array<{ id: string; name: string; isImpostor: boolean }>;
    firstSpeakerIndex: number;
  } | null>(null);
  const [localPhase, setLocalPhase] = useState<'players' | 'config' | 'reveal' | 'game' | 'finished'>('players');
  const [isHoldingReveal, setIsHoldingReveal] = useState(false);
  const [hasRevealedOnce, setHasRevealedOnce] = useState(false);
  const [tiebreakerTimeRemaining, setTiebreakerTimeRemaining] = useState<number | null>(null);
  const [isHoldingSecretWord, setIsHoldingSecretWord] = useState<boolean>(false);
  const [revealTextProgress, setRevealTextProgress] = useState<number>(0);
  const [showResultScreen, setShowResultScreen] = useState<boolean>(false);
  const processedTimeoutRef = useRef<{ playerId: string; round: number } | null>(null);
  const votingTimerStartedRef = useRef<{ phase: string; round: number } | null>(null);
  const tiebreakerTimerStartedRef = useRef<string | null>(null);

  const roomStateRef = useRef<ReturnType<typeof ref> | null>(null);
  const roomEventsRef = useRef<ReturnType<typeof ref> | null>(null);
  const stateListenerRef = useRef<(() => void) | null>(null);
  const eventsListenerRef = useRef<(() => void) | null>(null);
  const pendingStateRef = useRef<GameState | null>(null);
  const joinRequestedRef = useRef(false);
  const processedEventsRef = useRef<Set<string>>(new Set());

  const currentPlayer = gameState?.players.find((p) => p.id === playerId);
  const alivePlayers = gameState ? getAlivePlayers(gameState) : [];
  const cluesCurrentRound = gameState ? cluesForRound(gameState.clues, gameState.round) : [];

  useEffect(() => {
    setClueInput('');
    clueInputRef.current = '';
  }, [gameState?.phase, gameState?.round, gameState?.currentTurnIndex]);

  const resetSession = useCallback(() => {
    // Limpiar estados locales
    setRoomCode(null);
    setGameState(null);
    setChannelReady(false);
    setStatusMessage(null);
    setIsHost(false);
    joinRequestedRef.current = false;
    processedEventsRef.current.clear();
    pendingStateRef.current = null;
    // Limpiar estados de selección del anfitrión
    setSelectedTopicId(null);
    setShowClueOption(true);
    setAllowVoteChangeOption(true);
    setSingleWordOnlyOption(false);
    setVoteDisplayModeOption('visible');
    setSelectedTimeLimit(undefined);
    setSelectedVotingTimeLimit(undefined);
    setActiveTimeTab(null);
    setJoinCodeInput('');
    setClueInput('');
    clueInputRef.current = '';
  }, []);

  // Función para normalizar el estado de Firebase (asegurar que todos los campos requeridos existan)
  const normalizeState = useCallback((state: any): GameState | null => {
    if (!state) return null;
    
    // Normalizar jugadores y asegurar que isImpostor coincida con impostorId
    const players = Array.isArray(state.players) ? state.players : [];
    const impostorId = state.impostorId;
    
    // Sincronizar isImpostor con impostorId para garantizar consistencia
    // Asegurar que exactamente UN jugador es impostor
    // IMPORTANTE: impostorId es la fuente de verdad única
    const normalizedPlayers = players.map((player: any) => {
      // Siempre usar impostorId como fuente de verdad, ignorar cualquier valor previo de isImpostor
      const isImpostor = impostorId ? player.id === impostorId : false;
      return {
        ...player,
        isImpostor, // Sincronizar explícitamente
      };
    });
    
    // VERIFICACIÓN CRÍTICA: Si hay impostorId, debe haber exactamente UN jugador con ese ID marcado como impostor
    if (impostorId) {
      const impostorCount = normalizedPlayers.filter((p: any) => p.isImpostor).length;
      if (impostorCount !== 1) {
        console.warn(`Inconsistencia detectada en normalizeState: ${impostorCount} impostores encontrados. Corrigiendo...`);
        // Corregir: asegurar que solo el jugador con impostorId es impostor
        normalizedPlayers.forEach((player: any) => {
          player.isImpostor = player.id === impostorId;
        });
        // Verificar nuevamente después de la corrección
        const correctedCount = normalizedPlayers.filter((p: any) => p.isImpostor).length;
        if (correctedCount !== 1) {
          console.error(`Error crítico en normalizeState: No se pudo corregir. ImpostorId: ${impostorId}, Jugadores: ${normalizedPlayers.map((p: any) => ({ id: p.id, isImpostor: p.isImpostor }))}`);
        }
      }
    } else {
      // Si no hay impostorId, asegurar que ningún jugador es impostor
      normalizedPlayers.forEach((player: any) => {
        if (player.isImpostor) {
          console.warn(`Jugador ${player.id} marcado como impostor pero no hay impostorId. Corrigiendo...`);
          player.isImpostor = false;
        }
      });
    }
    
    return {
      code: state.code || '',
      topic: state.topic || '',
      secretWord: state.secretWord || '',
      selectedPlayer: state.selectedPlayer,
      selectedPlayerClue: state.selectedPlayerClue,
      showClue: state.showClue ?? true,
      allowVoteChange: state.allowVoteChange ?? true,
      singleWordOnly: state.singleWordOnly ?? false,
      voteDisplayMode: state.voteDisplayMode ?? 'visible',
      confirmedVotes: state.confirmedVotes ?? [],
      timeLimit: state.timeLimit,
      votingTimeLimit: state.votingTimeLimit,
      hostId: state.hostId || '',
      impostorId: impostorId,
      players: normalizedPlayers,
      phase: state.phase || 'lobby',
      currentTurnIndex: state.currentTurnIndex ?? -1,
      firstSpeakerIndex: state.firstSpeakerIndex,
      round: state.round ?? 0,
      clues: Array.isArray(state.clues) ? state.clues : [],
      votes: state.votes && typeof state.votes === 'object' ? state.votes : {},
      tiebreaker: state.tiebreaker,
      elimination: state.elimination,
      winner: state.winner,
      updatedAt: state.updatedAt || Date.now(),
    };
  }, []);

  // Función helper para limpiar un jugador (eliminar campos undefined)
  const cleanPlayer = (player: any): any => {
    const cleaned: any = { ...player };
    Object.keys(cleaned).forEach((key) => {
      if (cleaned[key] === undefined) {
        delete cleaned[key];
      }
    });
    return cleaned;
  };

  // Función para limpiar undefined de un objeto (Firebase no acepta undefined)
  const cleanStateForFirebase = (state: GameState): any => {
    const cleaned: any = { ...state };
    
    // Limpiar players array (eliminar undefined de cada jugador)
    if (Array.isArray(cleaned.players)) {
      cleaned.players = cleaned.players.map((player: any) => cleanPlayer(player));
    }
    
    // Limpiar clues array
    if (Array.isArray(cleaned.clues)) {
      cleaned.clues = cleaned.clues.map((clue: any) => {
        const cleanClue: any = { ...clue };
        Object.keys(cleanClue).forEach((key) => {
          if (cleanClue[key] === undefined) {
            delete cleanClue[key];
          }
        });
        return cleanClue;
      });
    }
    
    // Limpiar votes object
    if (cleaned.votes && typeof cleaned.votes === 'object') {
      const cleanVotes: any = {};
      Object.keys(cleaned.votes).forEach((key) => {
        if (cleaned.votes[key] !== undefined) {
          cleanVotes[key] = cleaned.votes[key];
        }
      });
      cleaned.votes = cleanVotes;
    }
    
    // Eliminar campos undefined del objeto principal
    Object.keys(cleaned).forEach((key) => {
      if (cleaned[key] === undefined) {
        delete cleaned[key];
      }
    });
    
    return cleaned;
  };

  const broadcastState = useCallback(
    (state: GameState) => {
      if (!database || !roomCode || !isHost) {
        pendingStateRef.current = state;
        return;
      }

      const stamped: GameState = { ...state, updatedAt: Date.now() };
      pendingStateRef.current = stamped;

      // Limpiar undefined antes de enviar a Firebase
      const cleanedState = cleanStateForFirebase(stamped);

      const stateRef = ref(database, `rooms/${roomCode}/state`);
      set(stateRef, cleanedState).catch((error) => {
        console.error('Error enviando estado a Firebase:', error);
        console.error('Estado que causó el error:', cleanedState);
        pendingStateRef.current = stamped;
      });
    },
    [isHost, roomCode],
  );


  const patchState = useCallback(
    (mutator: (previous: GameState) => GameState) => {
      setGameState((previous) => {
        if (!previous) return previous;
        const mutated = mutator(previous);
        const stamped = { ...mutated, updatedAt: Date.now() };
        if (isHost && database && roomCode) {
          const stateRef = ref(database, `rooms/${roomCode}/state`);
          // Limpiar undefined antes de enviar a Firebase
          const cleanedState = cleanStateForFirebase(stamped);
          set(stateRef, cleanedState).catch((error) => {
            console.error('Error actualizando estado en Firebase:', error);
            console.error('Estado que causó el error:', cleanedState);
          });
          pendingStateRef.current = stamped;
        }
        return stamped;
      });
    },
    [isHost, roomCode, database],
  );

  // Efecto para el contador de tiebreaker (10 segundos)
  useEffect(() => {
    if (gameState?.phase !== 'tiebreaker' || !gameState.tiebreaker) {
      setTiebreakerTimeRemaining(null);
      tiebreakerTimerStartedRef.current = null;
      return;
    }

    // Crear un ID único para esta ronda de tiebreaker usando round y tiedPlayers
    const tiebreakerId = `${gameState.round}-${gameState.tiebreaker.tiedPlayers.sort().join(',')}`;

    // Solo iniciar el contador una vez cuando se entra en tiebreaker
    if (tiebreakerTimerStartedRef.current !== tiebreakerId) {
      tiebreakerTimerStartedRef.current = tiebreakerId;
      setTiebreakerTimeRemaining(10);
    }

    const interval = setInterval(() => {
      setTiebreakerTimeRemaining((prev) => {
        if (prev === null || prev <= 0) {
          clearInterval(interval);
          // Si es el host y el tiempo se acabó, finalizar la votación automáticamente
          if (isHost) {
            patchState((prevState) => {
              if (prevState.phase !== 'tiebreaker') return prevState;
              
              // Resolver votos con los votos actuales (confirmados o no)
              const { targetId: eliminatedId, tie } = resolveVotes(prevState);
              
              if (tie || !eliminatedId) {
                return {
                  ...prevState,
                  votes: {},
                  confirmedVotes: [],
                  players: prevState.players.map((player) => {
                    const { vote, ...rest } = player;
                    return rest;
                  }),
                  phase: 'reveal',
                  tiebreaker: undefined,
                  elimination: undefined,
                };
              }
              
              return finishElimination(prevState, eliminatedId, prevState.players);
            });
          }
          return 0; // No volver a empezar el contador
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      clearInterval(interval);
    };
  }, [gameState?.phase, gameState?.round, gameState?.tiebreaker?.tiedPlayers, isHost, patchState]);

  // Temporizador para el turno actual
  useEffect(() => {
    if (!gameState || gameState.phase !== 'clue' || !gameState.timeLimit) {
      setTurnTimeRemaining(null);
      processedTimeoutRef.current = null;
      return;
    }

    const turnPlayer = gameState.currentTurnIndex >= 0 ? gameState.players[gameState.currentTurnIndex] : null;
    if (!turnPlayer) {
      setTurnTimeRemaining(null);
      processedTimeoutRef.current = null;
      return;
    }

    // Verificar si este jugador ya ha dado su pista
    const hasGivenClue = hasGivenClueThisRound(gameState, turnPlayer.id);
    if (hasGivenClue) {
      setTurnTimeRemaining(null);
      // Resetear el ref si el jugador ya dio pista (nuevo turno)
      if (processedTimeoutRef.current?.playerId !== turnPlayer.id || processedTimeoutRef.current?.round !== gameState.round) {
        processedTimeoutRef.current = null;
      }
      return;
    }

    // Si ya procesamos el timeout para este jugador en esta ronda, no hacer nada
    if (processedTimeoutRef.current?.playerId === turnPlayer.id && processedTimeoutRef.current?.round === gameState.round) {
      return;
    }

    // Iniciar temporizador desde el timeLimit
    setTurnTimeRemaining(gameState.timeLimit);

    // Capturar el playerId y round actuales para usar en el callback
    const currentPlayerId = turnPlayer.id;
    const currentRound = gameState.round;

    const interval = setInterval(() => {
      setTurnTimeRemaining((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(interval);
          
          // Si es el turno del jugador actual y hay algo escrito, enviarlo automáticamente
          const currentClueInput = clueInputRef.current;
          if (currentPlayerId === playerId && currentClueInput.trim()) {
            // Enviar inmediatamente lo que hay escrito
            handleSubmitClue(currentClueInput);
            setClueInput('');
            clueInputRef.current = '';
          }
          
          // Si es el host y el tiempo se acabó, esperar un momento para que el jugador envíe su pista
          if (isHost && prev !== null && prev <= 1) {
            // Verificar que no hayamos procesado ya este timeout para este jugador y ronda
            if (processedTimeoutRef.current?.playerId === currentPlayerId && processedTimeoutRef.current?.round === currentRound) {
              return 0;
            }

            // Esperar un pequeño delay para dar tiempo al jugador a enviar su pista automáticamente
            setTimeout(() => {
              patchState((prevState) => {
                if (prevState.phase !== 'clue') return prevState;
                const speakerIndex = prevState.currentTurnIndex;
                if (speakerIndex < 0) return prevState;
                const activePlayer = prevState.players[speakerIndex];
                if (!activePlayer || !activePlayer.alive) return prevState;

                // Verificar que es el mismo jugador que estábamos esperando
                if (activePlayer.id !== currentPlayerId) return prevState;

                // Verificar si ya tiene pista (el jugador pudo haber enviado algo automáticamente)
                const alreadySpoke = hasGivenClueThisRound(prevState, activePlayer.id);
                if (alreadySpoke) {
                  // El jugador ya envió su pista, solo avanzar al siguiente
                  const upcomingIndex = nextSpeakerIndex(prevState);
                  return {
                    ...prevState,
                    currentTurnIndex: upcomingIndex,
                  };
                }

                // Marcar que hemos procesado este timeout
                processedTimeoutRef.current = {
                  playerId: activePlayer.id,
                  round: prevState.round,
                };

                // Añadir pista especial "[SIN RESPUESTA]" solo si no se envió nada
                const clueEntry: GameClue = {
                  id: crypto.randomUUID(),
                  playerId: activePlayer.id,
                  word: '[SIN RESPUESTA]',
                  round: prevState.round,
                  createdAt: Date.now(),
                };

                const updatedPlayers = prevState.players.map((player, index) =>
                  index === speakerIndex
                    ? {
                        ...player,
                        clue: '[SIN RESPUESTA]',
                      }
                    : player,
                );

                const stateWithNewClue = {
                  ...prevState,
                  clues: [...prevState.clues, clueEntry],
                  players: updatedPlayers,
                };
                
                const upcomingIndex = nextSpeakerIndex(stateWithNewClue);

                return {
                  ...stateWithNewClue,
                  currentTurnIndex: upcomingIndex,
                };
              });
            }, 500); // Esperar 500ms para dar tiempo al jugador a enviar su pista
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      clearInterval(interval);
      setTurnTimeRemaining(null);
    };
  }, [gameState?.phase, gameState?.currentTurnIndex, gameState?.timeLimit, gameState?.clues, gameState?.round, isHost, patchState]);

  const sendBroadcast = useCallback((event: string, payload: unknown) => {
    if (!database || !roomCode) return;
    const eventsRef = ref(database, `rooms/${roomCode}/events`);
    push(eventsRef, { type: event, payload, timestamp: serverTimestamp(), playerId }).catch((error) => {
      console.error('Error enviando evento', event, error);
    });
  }, [roomCode, playerId]);

  // Listener para el estado del juego
  useEffect(() => {
    if (!database || !roomCode) {
      console.log('Listener no activado:', { database: !!database, roomCode });
      return () => undefined;
    }

    console.log('Activando listener para sala:', roomCode, 'isHost:', isHost);
    const stateRef = ref(database, `rooms/${roomCode}/state`);
    roomStateRef.current = stateRef;

    const unsubscribe = onValue(stateRef, (snapshot) => {
      const rawState = snapshot.val();
      console.log('Listener de Firebase activado. Estado recibido:', rawState ? 'existe' : 'null', 'isHost:', isHost);
      
      // Si el estado es null y no somos el host, significa que el host cerró la sala
      if (!rawState && !isHost && roomCode) {
        setStatusMessage('El anfitrión ha finalizado la sesión');
        setTimeout(() => {
          resetSession();
        }, 2000);
        return;
      }
      
      const newState = normalizeState(rawState);
      console.log('Estado normalizado:', newState ? `fase: ${newState.phase}, jugadores: ${newState.players.length}` : 'null');
      
      setGameState((prev) => {
        // Si somos el host y tenemos estado local, mantenerlo (es la fuente de verdad)
        // PERO solo si el estado de Firebase no es más reciente
        if (isHost && prev) {
          if (newState && newState.updatedAt > prev.updatedAt) {
            // El estado de Firebase es más reciente, usarlo
            setChannelReady(true);
            return newState;
          }
          setChannelReady(true);
          return prev;
        }
        
        // Si somos el host y tenemos estado pendiente, usarlo
        if (isHost && pendingStateRef.current) {
          if (newState && newState.updatedAt > pendingStateRef.current.updatedAt) {
            setChannelReady(true);
            return newState;
          }
          setChannelReady(true);
          return pendingStateRef.current;
        }
        
        // Si NO somos host, SIEMPRE usar el estado de Firebase si existe (el host es la fuente de verdad)
        if (!isHost) {
          if (newState) {
            console.log('Actualizando gameState desde Firebase (no host):', {
              phase: newState.phase,
              players: newState.players.length,
              playerInState: newState.players.some(p => p.id === playerId)
            });
            setChannelReady(true);
            setStatusMessage(null); // Limpiar mensaje cuando recibimos el estado
            return newState;
          }
          // Si no hay estado en Firebase pero tenemos uno local, mantenerlo temporalmente
          if (prev) {
            setChannelReady(true);
            return prev;
          }
        }
        
        // Si hay estado en Firebase y no tenemos estado local, usarlo
        if (newState && !prev) {
          console.log('Estableciendo gameState inicial desde Firebase:', {
            phase: newState.phase,
            players: newState.players.length
          });
          setChannelReady(true);
          setStatusMessage(null); // Limpiar mensaje cuando recibimos el estado
          return newState;
        }
        
        // Mantener el estado actual si existe
        if (prev) {
          setChannelReady(true);
          return prev;
        }
        
        return prev;
      });
    });

    stateListenerRef.current = unsubscribe;

    return () => {
      if (stateListenerRef.current) {
        off(stateRef, 'value', stateListenerRef.current);
        stateListenerRef.current = null;
      }
      roomStateRef.current = null;
      setChannelReady(false);
    };
  }, [database, roomCode, isHost]);

  // Listener para eventos del juego
  useEffect(() => {
    if (!database || !roomCode) {
      return () => undefined;
    }

    const eventsRef = ref(database, `rooms/${roomCode}/events`);
    roomEventsRef.current = eventsRef;

    const unsubscribe = onValue(eventsRef, (snapshot) => {
      const events = snapshot.val();
      if (!events) return;

      // Procesar solo eventos nuevos (evitar procesar eventos antiguos)
      Object.entries(events).forEach(([eventKey, eventData]: [string, any]) => {
        if (!eventData) return;
        
        // Crear un ID único para este evento
        const eventId = `${eventKey}-${eventData.type}-${eventData.playerId}-${eventData.timestamp || ''}`;
        
        // Si ya procesamos este evento, ignorarlo
        if (processedEventsRef.current.has(eventId)) {
          return;
        }
        processedEventsRef.current.add(eventId);
        
        // Limpiar eventos antiguos del set (mantener solo los últimos 100)
        if (processedEventsRef.current.size > 100) {
          const firstKey = processedEventsRef.current.values().next().value;
          if (firstKey) {
            processedEventsRef.current.delete(firstKey);
          }
        }
        
        // Ignorar nuestros propios eventos EXCEPTO READY_FOR_ROUND, SUBMIT_CLUE, SUBMIT_VOTE y CONFIRM_VOTE (el host necesita procesar estos)
        if (eventData.playerId === playerId && eventData.type !== 'JOIN_REQUEST' && eventData.type !== 'READY_FOR_ROUND' && eventData.type !== 'SUBMIT_CLUE' && eventData.type !== 'SUBMIT_VOTE' && eventData.type !== 'CONFIRM_VOTE') {
          return;
        }

        switch (eventData.type) {

          case 'SUBMIT_CLUE': {
            if (!isHost) return;
            const { playerId: cluePlayerId, word } = eventData.payload as CluePayload;

            patchState((prev) => {
              if (prev.phase !== 'clue') return prev;
              const speakerIndex = prev.currentTurnIndex;
              if (speakerIndex < 0) return prev;
              const activePlayer = prev.players[speakerIndex];
              if (!activePlayer || activePlayer.id !== cluePlayerId || !activePlayer.alive) {
                return prev;
              }

              const trimmedWord = sanitizeWord(word);
              if (!trimmedWord) return prev;

              const alreadySpoke = hasGivenClueThisRound(prev, cluePlayerId);
              if (alreadySpoke) return prev;

              const clueEntry: GameClue = {
                id: crypto.randomUUID(),
                playerId: cluePlayerId,
                word: trimmedWord,
                round: prev.round,
                createdAt: Date.now(),
              };

              const updatedPlayers = prev.players.map((player, index) =>
                index === speakerIndex
                  ? {
                      ...player,
                      clue: trimmedWord,
                    }
                  : player,
              );

              // Calcular el siguiente turno con el estado actualizado
              const stateWithNewClue = {
                ...prev,
                clues: [...prev.clues, clueEntry],
                players: updatedPlayers,
              };
              
              const upcomingIndex = nextSpeakerIndex(stateWithNewClue);

              return {
                ...stateWithNewClue,
                currentTurnIndex: upcomingIndex,
              };
            });
            break;
          }

          case 'SUBMIT_VOTE': {
            if (!isHost) return;
            const { voterId, targetId } = eventData.payload as VotePayload;

            patchState((prev) => {
              // Manejar votos tanto en fase voting como tiebreaker
              if (prev.phase !== 'voting' && prev.phase !== 'tiebreaker') return prev;
              const voter = prev.players.find((player) => player.id === voterId && player.alive);
              const target = prev.players.find((player) => player.id === targetId && player.alive);
              if (!voter || !target) return prev;
              
              // No permitir votar a uno mismo
              if (voterId === targetId) return prev;

              // Si estamos en tiebreaker, verificar restricciones
              if (prev.phase === 'tiebreaker' && prev.tiebreaker) {
                // Solo los jugadores NO empatados pueden votar
                if (prev.tiebreaker.tiedPlayers.includes(voterId)) return prev;
                // Solo se puede votar a jugadores empatados
                if (!prev.tiebreaker.tiedPlayers.includes(targetId)) return prev;
              }

              const updatedVotes = { ...prev.votes, [voterId]: targetId };
              const updatedPlayers = prev.players.map((player) =>
                player.id === voterId
                  ? {
                      ...player,
                      vote: targetId,
                    }
                  : player,
              );

              const aliveCount = getAlivePlayers(prev).length;
              
              // En tiebreaker, solo cuentan los jugadores que pueden votar (no empatados)
              const eligibleVoters = prev.phase === 'tiebreaker' && prev.tiebreaker
                ? aliveCount - prev.tiebreaker.tiedPlayers.length
                : aliveCount;
              
              // Verificar si todos han votado (y confirmado si allowVoteChange está activado)
              let everyoneVoted = false;
              if (prev.allowVoteChange) {
                // Si se permite cambiar voto, todos deben haber confirmado
                everyoneVoted = Object.keys(updatedVotes).length >= eligibleVoters && 
                               (prev.confirmedVotes?.length ?? 0) >= eligibleVoters;
              } else {
                // Si no se permite cambiar voto, todos deben haber votado
                everyoneVoted = Object.keys(updatedVotes).length >= eligibleVoters;
              }

              if (!everyoneVoted) {
                return {
                  ...prev,
                  votes: updatedVotes,
                  players: updatedPlayers,
                };
              }

              // Si estamos en tiebreaker, resolver el desempate
              if (prev.phase === 'tiebreaker') {
              const { targetId: eliminatedId, tie } = resolveVotes({ ...prev, votes: updatedVotes });

                // Si sigue el empate, mostrar pantalla de empate
              if (tie || !eliminatedId) {
                return {
                  ...prev,
                    votes: {},
                    confirmedVotes: [],
                    players: updatedPlayers.map((player) => {
                      const { vote, ...rest } = player;
                      return rest;
                    }),
                    phase: 'reveal',
                    tiebreaker: undefined,
                    elimination: undefined,
                  };
                }
                
                // Si se resolvió el empate, eliminar al jugador
                return finishElimination(prev, eliminatedId, updatedPlayers);
              }

              // Lógica normal de votación
              const { targetId: eliminatedId, tie, tiedPlayers, voteCount } = resolveVotes({ ...prev, votes: updatedVotes });

              // En caso de empate, pasar a fase tiebreaker
              if (tie || !eliminatedId) {
                // Guardar los votos anteriores y pasar a tiebreaker
                // Establecer automáticamente los votos previos para los jugadores que no están empatados
                const initialVotes: Record<string, string> = {};
                const playersWithVotes = updatedPlayers.map((player) => {
                  // Mantener el voto solo si votó a uno de los empatados
                  const playerVote = player.vote;
                  const tiedPlayersArray = Array.isArray(tiedPlayers) ? tiedPlayers : [];
                  const keptVote = playerVote && tiedPlayersArray.includes(playerVote) ? playerVote : undefined;
                  
                  // Si el jugador no está empatado y tiene un voto a uno de los empatados, establecerlo automáticamente
                  if (!tiedPlayersArray.includes(player.id) && keptVote) {
                    initialVotes[player.id] = keptVote;
                  }
                  
                  return { ...player, vote: keptVote };
                });
                
                return {
                  ...prev,
                  votes: initialVotes, // Establecer los votos previos automáticamente
                  confirmedVotes: [],
                  players: playersWithVotes,
                  phase: 'tiebreaker',
                  tiebreaker: {
                    tiedPlayers: [...tiedPlayers],
                    voteCount,
                    previousVotes: updatedVotes,
                  },
                  elimination: undefined,
                };
              }

              return finishElimination(prev, eliminatedId, updatedPlayers);
            });
            break;
          }

          case 'CLEAR_VOTE': {
            if (!isHost) return;
            const { playerId: voterId } = eventData.payload as { playerId: string };
            patchState((prev) => {
              if (prev.phase !== 'voting' && prev.phase !== 'tiebreaker') return prev;
              if (!prev.votes[voterId]) return prev;
              
              // Si el voto está confirmado, no permitir limpiarlo
              if (prev.confirmedVotes?.includes(voterId)) return prev;
              
              const updatedVotes = { ...prev.votes };
              delete updatedVotes[voterId];
              const updatedPlayers = prev.players.map((player) => {
                if (player.id === voterId) {
                  const { vote, ...rest } = player;
                  return rest;
                }
                return player;
              });
              return {
                ...prev,
                votes: updatedVotes,
                players: updatedPlayers,
              };
            });
            break;
          }

          case 'CONFIRM_VOTE': {
            if (!isHost) return;
            const { playerId: voterId } = eventData.payload as { playerId: string };
            patchState((prev) => {
              if (prev.phase !== 'voting' && prev.phase !== 'tiebreaker') return prev;
              // Solo se puede confirmar si hay un voto
              if (!prev.votes[voterId]) return prev;
              // Si ya está confirmado, no hacer nada
              if (prev.confirmedVotes?.includes(voterId)) return prev;
              
              const updatedConfirmedVotes = [...(prev.confirmedVotes || []), voterId];
              const alivePlayers = getAlivePlayers(prev);
              const aliveCount = alivePlayers.length;
              
              // En tiebreaker, solo cuentan los jugadores que pueden votar (no empatados)
              const eligibleVoters = prev.phase === 'tiebreaker' && prev.tiebreaker
                ? aliveCount - prev.tiebreaker.tiedPlayers.length
                : aliveCount;
              
              // Verificar si todos han confirmado (solo si allowVoteChange está activado)
              const everyoneConfirmed = prev.allowVoteChange && 
                                       Object.keys(prev.votes).length >= eligibleVoters && 
                                       updatedConfirmedVotes.length >= eligibleVoters;
              
              if (everyoneConfirmed) {
                // Si estamos en tiebreaker, resolver el desempate
                if (prev.phase === 'tiebreaker') {
                  const { targetId: eliminatedId, tie } = resolveVotes(prev);
                  
                  // Si sigue el empate, mostrar pantalla de empate
                  if (tie || !eliminatedId) {
                    return {
                      ...prev,
                      votes: {},
                      confirmedVotes: [],
                      players: prev.players.map((player) => {
                        const { vote, ...rest } = player;
                        return rest;
                      }),
                      phase: 'reveal',
                      tiebreaker: undefined,
                      elimination: undefined,
                    };
                  }
                  
                  // Si se resolvió el empate, eliminar al jugador
                  return finishElimination(
                    { ...prev, confirmedVotes: updatedConfirmedVotes },
                    eliminatedId,
                    prev.players
                  );
                }
                
                // Lógica normal de votación
                const { targetId: eliminatedId, tie, tiedPlayers, voteCount } = resolveVotes(prev);
                
                // En caso de empate, pasar a fase tiebreaker
                if (tie || !eliminatedId) {
                  // Establecer automáticamente los votos previos para los jugadores que no están empatados
                  const initialVotes: Record<string, string> = {};
                  const playersWithVotes = prev.players.map((player) => {
                    // Mantener el voto solo si votó a uno de los empatados
                    const playerVote = player.vote;
                    const tiedPlayersArray = Array.isArray(tiedPlayers) ? tiedPlayers : [];
                    const keptVote = playerVote && tiedPlayersArray.includes(playerVote) ? playerVote : undefined;
                    
                    // Si el jugador no está empatado y tiene un voto a uno de los empatados, establecerlo automáticamente
                    if (!tiedPlayersArray.includes(player.id) && keptVote) {
                      initialVotes[player.id] = keptVote;
                    }
                    
                    return { ...player, vote: keptVote };
                  });
                  
                  return {
                    ...prev,
                    votes: initialVotes, // Establecer los votos previos automáticamente
                    confirmedVotes: [],
                    players: playersWithVotes,
                    phase: 'tiebreaker',
                    tiebreaker: {
                      tiedPlayers: [...tiedPlayers],
                      voteCount,
                      previousVotes: prev.votes,
                    },
                    elimination: undefined,
                  };
                }
                
                return finishElimination(
                  { ...prev, confirmedVotes: updatedConfirmedVotes },
                  eliminatedId,
                  prev.players
                );
              }
              
              return {
                ...prev,
                confirmedVotes: updatedConfirmedVotes,
              };
            });
            break;
          }

          case 'READY_FOR_ROUND': {
            if (!isHost) return;
            const { playerId: readyPlayerId, ready } = eventData.payload as ReadyPayload;
            patchState((prev) => {
              if (prev.phase !== 'wordReveal') return prev;
              const updatedPlayers = prev.players.map((player) =>
                player.id === readyPlayerId
                  ? {
                      ...player,
                      readyForRound: ready,
                    }
                  : player,
              );
              return {
                ...prev,
                players: updatedPlayers,
              };
            });
            break;
          }

          case 'PLAYER_LEAVE': {
            if (!isHost) return;
            const { playerId: leaverId } = eventData.payload as LeavePayload;
            patchState((prev) => {
              if (!prev.players.some((p) => p.id === leaverId)) return prev;
              const remainingPlayers = prev.players.filter((p) => p.id !== leaverId);
              let nextState: GameState = {
                ...prev,
                players: remainingPlayers,
              };

              if (prev.phase === 'clue') {
                const nextIndex = remainingPlayers.length
                  ? nextSpeakerIndex({ ...prev, players: remainingPlayers })
                  : -1;
                nextState = {
                  ...nextState,
                  currentTurnIndex: nextIndex,
                };
              }

              return nextState;
            });
            break;
          }
        }
      });
    });

    eventsListenerRef.current = unsubscribe;

    return () => {
      if (eventsListenerRef.current) {
        off(eventsRef, 'value', eventsListenerRef.current);
        eventsListenerRef.current = null;
      }
      roomEventsRef.current = null;
      // No resetear joinRequestedRef aquí porque podría causar múltiples solicitudes
      // joinRequestedRef.current = false;
    };
  }, [database, roomCode, isHost, gameState, patchState, playerId, playerName, resetSession, sendBroadcast, channelReady, broadcastState]);

  // Enviar estado pendiente cuando el canal esté listo
  useEffect(() => {
    if (channelReady && pendingStateRef.current && isHost && database && roomCode) {
      broadcastState(pendingStateRef.current);
    }
  }, [channelReady, isHost, database, roomCode, broadcastState]);

  const handleCreateRoom = useCallback(() => {
    if (!database) {
      setStatusMessage('Configura las variables de entorno de Firebase antes de crear una sala.');
      return;
    }

    const trimmedName = sanitizeName(playerName);
    if (!trimmedName) {
      setStatusMessage('Introduce un nombre antes de crear una sala.');
      return;
    }

    const code = generateRoomCode();
    
    const hostPlayer: PlayerState = {
      id: playerId,
      name: trimmedName,
      isHost: true,
      isImpostor: false,
      alive: true,
      readyForRound: false,
    };

    setSelectedTopicId(null);
    setShowClueOption(true);
    setSelectedTimeLimit(undefined);
    setSelectedVotingTimeLimit(undefined);
    setActiveTimeTab(null);

    const initialState: GameState = {
      code,
      topic: '',
      secretWord: '',
      selectedPlayer: undefined,
      selectedPlayerClue: undefined,
      showClue: true,
      allowVoteChange: true,
      singleWordOnly: false,
      voteDisplayMode: 'visible',
      hostId: playerId,
      impostorId: undefined,
      players: [hostPlayer],
      phase: 'lobby',
      currentTurnIndex: -1,
      firstSpeakerIndex: undefined,
      round: 0,
      clues: [],
      votes: {},
      confirmedVotes: [],
      elimination: undefined,
      winner: undefined,
      updatedAt: Date.now(),
    };

    // Establecer el estado local PRIMERO antes de cambiar roomCode
    setGameState(initialState);
    pendingStateRef.current = initialState;
    
    // Luego establecer roomCode e isHost (esto activará el listener)
    setIsHost(true);
    setRoomCode(code);
    setStatusMessage(null);
    
    // Enviar a Firebase después de que el listener esté configurado
    setTimeout(() => {
      if (database) {
        broadcastState(initialState);
      }
    }, 300);
  }, [playerId, playerName, database, broadcastState]);

  const handleJoinRoom = useCallback(async () => {
    if (!database) {
      setStatusMessage('Configura Firebase antes de unirte a una sala.');
      return;
    }

    const trimmedName = sanitizeName(playerName);
    if (!trimmedName) {
      setStatusMessage('Introduce un nombre antes de unirte.');
      return;
    }

    const sanitizedCode = joinCodeInput.trim().toUpperCase();
    if (sanitizedCode.length !== 3 || !/^[A-Z][0-9]{2}$/.test(sanitizedCode)) {
      setStatusMessage('Introduce un código de sala válido (1 letra + 2 números, ej: A12).');
      return;
    }

    setIsHost(false);
    setRoomCode(sanitizedCode);
    setStatusMessage('Uniéndose a la sala...');

    // Intentar añadirse directamente al estado
    const stateRef = ref(database, `rooms/${sanitizedCode}/state`);
    let unsubscribeFn: (() => void) | null = null;
    const snapshot = await new Promise<any>((resolve, reject) => {
      unsubscribeFn = onValue(
        stateRef,
        (snap) => {
        if (unsubscribeFn) {
          unsubscribeFn();
          unsubscribeFn = null;
        }
          const value = snap.val();
          console.log('Estado de la sala leído:', value ? 'existe' : 'no existe');
          resolve(value);
        },
        (error) => {
          console.error('Error al leer el estado de la sala:', error);
          if (unsubscribeFn) {
            unsubscribeFn();
            unsubscribeFn = null;
          }
          reject(error);
        },
        { onlyOnce: true }
      );
      
      // Timeout de seguridad para evitar que se quede colgado
      setTimeout(() => {
        if (unsubscribeFn) {
          unsubscribeFn();
          unsubscribeFn = null;
        }
        reject(new Error('Timeout al leer el estado de la sala (5 segundos)'));
      }, 5000);
    }).catch((error) => {
      if (unsubscribeFn) {
        unsubscribeFn();
        unsubscribeFn = null;
      }
      throw error;
    });

    try {
      if (!snapshot) {
        setStatusMessage('La sala no existe.');
        resetSession();
        return;
      }

      const currentState = normalizeState(snapshot);
      if (!currentState) {
        setStatusMessage('Error al leer el estado de la sala.');
        resetSession();
        return;
      }

      // Verificar si ya está en la sala
      if (currentState.players.some((p: PlayerState) => p.id === playerId)) {
        setStatusMessage(null);
        return;
      }

      // Verificar límites
      if (currentState.players.length >= MAX_PLAYERS) {
        setStatusMessage('La sala está completa.');
        resetSession();
        return;
      }

      // Verificar nombre
      const nameTaken = currentState.players.some((p: PlayerState) => p.name.toLowerCase() === trimmedName.toLowerCase());
      if (nameTaken) {
        setStatusMessage('El nombre ya está en uso.');
        resetSession();
        return;
      }

      // Añadirse al estado
      const newPlayer: PlayerState = {
        id: playerId,
        name: trimmedName,
        isHost: false,
        isImpostor: false,
        alive: true,
        readyForRound: false,
      };

      const updatedState: GameState = {
        ...currentState,
        players: [...currentState.players, newPlayer],
        updatedAt: Date.now(),
      };

      const cleanedState = cleanStateForFirebase(updatedState);
      console.log('Escribiendo estado actualizado en Firebase...', {
        roomCode: sanitizedCode,
        players: cleanedState.players?.length,
        phase: cleanedState.phase
      });
      try {
      await set(stateRef, cleanedState);
        console.log('Estado escrito correctamente. El listener debería actualizar gameState automáticamente.');
        // No establecer statusMessage a null inmediatamente, dejar que el listener lo haga
        // El listener actualizará gameState y eso hará que se muestre el lobby
      } catch (writeError: any) {
        console.error('Error al escribir en Firebase:', writeError);
        throw writeError;
      }
    } catch (error: any) {
      console.error('Error al unirse a la sala:', error);
      const errorMessage = error?.message || 'Error desconocido';
      if (errorMessage.includes('permission') || errorMessage.includes('Permission')) {
        setStatusMessage('Error de permisos en Firebase. Verifica las reglas de seguridad.');
      } else if (errorMessage.includes('Timeout')) {
        setStatusMessage('Timeout: La sala no responde. Verifica que la sala existe y que Firebase está configurado correctamente.');
      } else {
        setStatusMessage(`Error al unirse a la sala: ${errorMessage}`);
      }
      resetSession();
    }
  }, [joinCodeInput, playerName, database, playerId, resetSession, normalizeState, cleanStateForFirebase]);

  const handleLeaveRoom = useCallback(() => {
    if (!roomCode) return;
    
    // Limpiar todo el estado local primero para volver a la pantalla de inicio inmediatamente
    resetSession();
    
    // Luego hacer las operaciones de Firebase en segundo plano
    if (isHost) {
      if (!window.confirm('Cerrar sala? Esto expulsará a todos los jugadores.')) {
        // Si cancela, restaurar el estado (aunque esto es raro que pase)
        return;
      }
      // Eliminar el estado de Firebase para que todos los jugadores sepan que la sala se cerró
      if (database && roomCode) {
        const stateRef = ref(database, `rooms/${roomCode}/state`);
        set(stateRef, null).catch((error) => {
          console.error('Error eliminando sala:', error);
        });
      }
    } else {
      // Si no es host, intentar remover al jugador del estado (opcional, no crítico)
      // No bloqueamos la salida si esto falla
      if (database && roomCode) {
        sendBroadcast('PLAYER_LEAVE', { playerId } satisfies LeavePayload);
      }
    }
  }, [isHost, database, playerId, resetSession, roomCode, sendBroadcast]);

  const handleStartGame = useCallback(() => {
    if (!gameState || !isHost) return;

    if (!selectedTopicId) {
      setStatusMessage('Selecciona una temática antes de comenzar.');
      return;
    }

    if (gameState.players.length < MIN_PLAYERS) {
      setStatusMessage(`Se necesitan al menos ${MIN_PLAYERS} jugadores para empezar.`);
      return;
    }

    const selectedTopic = topics[selectedTopicId];
    const randomPlayer = getRandomPlayerForTopic(selectedTopicId);

    if (!randomPlayer) {
      setStatusMessage('No hay jugadores disponibles para esta temática.');
      return;
    }

    patchState((prev) => {
      // Verificar que hay jugadores antes de empezar
      if (prev.players.length === 0) {
        return prev;
      }

      // Mantener el orden de llegada (no reordenar los jugadores)
      // Asegurar que TODOS los jugadores empiezan como NO impostores
      const reshuffledPlayers = prev.players.map((player) => {
        const { clue, vote, ...rest } = player;
        return {
          ...rest,
          alive: true,
          isImpostor: false, // Asegurar que todos empiezan como no impostores
          readyForRound: false,
        };
      });
      
      // Seleccionar EXACTAMENTE UN impostor aleatoriamente
      const impostorIndex = Math.floor(Math.random() * reshuffledPlayers.length);
      const impostorId = reshuffledPlayers[impostorIndex].id;
      
      // Asignar el rol de impostor SOLO al jugador seleccionado usando map para crear nuevos objetos
      const finalPlayers = reshuffledPlayers.map((player, index) => {
        if (index === impostorIndex) {
          return {
            ...player,
        isImpostor: true,
      };
        }
        return {
          ...player,
          isImpostor: false, // Asegurar explícitamente que todos los demás son false
        };
      });

      // VERIFICACIÓN CRÍTICA: Asegurar que exactamente 1 jugador es impostor
      const impostorCount = finalPlayers.filter(p => p.isImpostor).length;
      if (impostorCount !== 1) {
        console.error('Error crítico: No se pudo asignar exactamente 1 impostor. Contador:', impostorCount);
        // Forzar la corrección: asegurar que solo el seleccionado es impostor
        const correctedPlayers = finalPlayers.map((player, index) => ({
          ...player,
          isImpostor: index === impostorIndex,
        }));
        const correctedCount = correctedPlayers.filter(p => p.isImpostor).length;
        if (correctedCount !== 1) {
          console.error('Error crítico: No se pudo corregir la asignación del impostor');
          return prev; // No cambiar el estado si hay un error
        }
        // Usar los jugadores corregidos
        reshuffledPlayers.length = 0;
        reshuffledPlayers.push(...correctedPlayers);
      } else {
        // Usar los jugadores correctos
        reshuffledPlayers.length = 0;
        reshuffledPlayers.push(...finalPlayers);
      }

      // Seleccionar el primer jugador que habla aleatoriamente de entre los jugadores vivos
      const aliveIndices = reshuffledPlayers
        .map((player, index) => (player.alive ? index : -1))
        .filter((index) => index !== -1);
      const randomAliveIndex = Math.floor(Math.random() * aliveIndices.length);
      const firstSpeakerIndex = aliveIndices[randomAliveIndex];

      return {
        ...prev,
        topic: selectedTopic.name,
        secretWord: randomPlayer.name,
        selectedPlayer: randomPlayer.name,
        selectedPlayerClue: randomPlayer.clue,
        showClue: showClueOption,
        allowVoteChange: allowVoteChangeOption,
        singleWordOnly: singleWordOnlyOption,
        voteDisplayMode: voteDisplayModeOption,
        timeLimit: selectedTimeLimit,
        votingTimeLimit: selectedVotingTimeLimit,
        players: reshuffledPlayers,
        impostorId,
        phase: 'wordReveal',
        currentTurnIndex: firstSpeakerIndex,
        firstSpeakerIndex, // Guardar el índice del primer jugador para mantenerlo en todas las rondas
        round: 1,
        clues: [],
        votes: {},
        elimination: undefined,
        winner: undefined,
      };
    });

    setStatusMessage('');
  }, [gameState, isHost, selectedTopicId, showClueOption, allowVoteChangeOption, singleWordOnlyOption, voteDisplayModeOption, selectedTimeLimit, selectedVotingTimeLimit, patchState]);

  // Sincronizar opciones de personalización con gameState
  useEffect(() => {
    if (gameState && isHost) {
      setAllowVoteChangeOption(gameState.allowVoteChange ?? true);
      setSingleWordOnlyOption(gameState.singleWordOnly ?? false);
      setVoteDisplayModeOption(gameState.voteDisplayMode ?? 'visible');
    }
  }, [gameState?.allowVoteChange, gameState?.singleWordOnly, gameState?.voteDisplayMode, isHost]);

  const handleBeginClues = useCallback(() => {
    if (!gameState || !isHost) return;
    patchState((prev) => {
      // Si es la primera ronda y no hay firstSpeakerIndex, establecerlo
      const firstIndex = prev.firstSpeakerIndex !== undefined 
        ? prev.firstSpeakerIndex 
        : (prev.currentTurnIndex >= 0 ? prev.currentTurnIndex : undefined);
      
      return {
        ...prev,
        phase: 'clue',
        currentTurnIndex: nextSpeakerIndex(prev),
        firstSpeakerIndex: firstIndex,
      };
    });
  }, [gameState, isHost, patchState]);

  // Auto-avanzar desde wordReveal después de 10 segundos con cuenta regresiva
  useEffect(() => {
    if (!gameState || gameState.phase !== 'wordReveal') {
      setCountdown(null);
      return;
    }

    // Iniciar cuenta regresiva desde 10
    setCountdown(10);

    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(interval);
          if (isHost) {
            handleBeginClues();
          }
          return null;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      clearInterval(interval);
      setCountdown(null);
    };
  }, [gameState?.phase, gameState?.round, isHost, handleBeginClues]);

  const handleOpenVoting = useCallback(() => {
    if (!gameState || !isHost) return;
    const playersReady = getAlivePlayers(gameState).length;
    const cluesGiven = cluesCurrentRound.length;
    if (cluesGiven < playersReady) {
      setStatusMessage('Aún faltan pistas de algunos jugadores.');
      return;
    }
    patchState((prev) => ({
      ...prev,
      phase: 'voting',
      votes: {},
      confirmedVotes: [],
      players: prev.players.map((player) => {
        const { vote, ...rest } = player;
        return rest;
      }),
      currentTurnIndex: -1,
    }));
  }, [cluesCurrentRound.length, gameState, isHost, patchState]);


  const handleFinalizeVoting = useCallback(() => {
    if (!isHost) return;
    patchState((prev) => {
      if (prev.phase !== 'voting') return prev;
      
      const { targetId, tie, tiedPlayers, voteCount } = resolveVotes(prev);
      
      // En caso de empate, pasar a fase tiebreaker
      if (tie || !targetId) {
        // Establecer automáticamente los votos previos para los jugadores que no están empatados
        const initialVotes: Record<string, string> = {};
        const playersWithVotes = prev.players.map((player) => {
          // Mantener el voto solo si votó a uno de los empatados
          const playerVote = player.vote;
          const tiedPlayersArray = Array.isArray(tiedPlayers) ? tiedPlayers : [];
          const keptVote = playerVote && tiedPlayersArray.includes(playerVote) ? playerVote : undefined;
          
          // Si el jugador no está empatado y tiene un voto a uno de los empatados, establecerlo automáticamente
          if (!tiedPlayersArray.includes(player.id) && keptVote) {
            initialVotes[player.id] = keptVote;
          }
          
          return { ...player, vote: keptVote };
        });
        
        return {
      ...prev,
          votes: initialVotes, // Establecer los votos previos automáticamente
          confirmedVotes: [],
          players: playersWithVotes,
          phase: 'tiebreaker',
          tiebreaker: {
            tiedPlayers: [...tiedPlayers],
            voteCount,
            previousVotes: prev.votes,
          },
          elimination: undefined,
        };
      }
      
      return finishElimination(prev, targetId, prev.players);
    });
  }, [isHost, patchState]);

  // Temporizador para la fase de votación
  useEffect(() => {
    if (!gameState || gameState.phase !== 'voting' || !gameState.votingTimeLimit) {
      setVotingTimeRemaining(null);
      votingTimerStartedRef.current = null;
      return;
    }

    // Verificar si el timer ya se inició para esta fase y ronda
    if (votingTimerStartedRef.current?.phase === gameState.phase && 
        votingTimerStartedRef.current?.round === gameState.round) {
      // El timer ya está corriendo para esta fase/ronda, no reiniciarlo
      return;
    }

    // Marcar que el timer se ha iniciado para esta fase/ronda
    votingTimerStartedRef.current = {
      phase: gameState.phase,
      round: gameState.round,
    };

    // Iniciar temporizador desde el votingTimeLimit solo la primera vez
    setVotingTimeRemaining(gameState.votingTimeLimit);

    const interval = setInterval(() => {
      setVotingTimeRemaining((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(interval);
          votingTimerStartedRef.current = null;
          // Si es el host y el tiempo se acabó, asignar votos aleatorios y cerrar votación
          if (isHost && prev !== null && prev <= 1) {
            patchState((prevState) => {
              if (prevState.phase !== 'voting') return prevState;
              
              const alivePlayers = getAlivePlayers(prevState);
              const updatedVotes = { ...prevState.votes };
              let updatedConfirmedVotes = [...(prevState.confirmedVotes || [])];
              
              // Asignar votos aleatorios a jugadores que no han votado
              // Asegurar que cada jugador solo vote una vez
              alivePlayers.forEach((player) => {
                // Solo asignar voto si el jugador no ha votado aún
                if (!updatedVotes[player.id]) {
                  // Obtener lista de jugadores vivos excluyendo al propio jugador
                  const possibleTargets = alivePlayers.filter(p => p.id !== player.id);
                  if (possibleTargets.length > 0) {
                    // Seleccionar un objetivo aleatorio
                    const randomTarget = possibleTargets[Math.floor(Math.random() * possibleTargets.length)];
                    updatedVotes[player.id] = randomTarget.id;
                  }
                }
                // Si allowVoteChange está activado y el jugador tiene voto pero no confirmado, confirmarlo automáticamente
                if (prevState.allowVoteChange && updatedVotes[player.id] && !updatedConfirmedVotes.includes(player.id)) {
                  updatedConfirmedVotes.push(player.id);
                }
              });
              
              // Resolver votos con el estado actualizado
              const { targetId, tie, tiedPlayers, voteCount } = resolveVotes({ ...prevState, votes: updatedVotes });
              
              // En caso de empate, pasar a fase tiebreaker
    if (tie || !targetId) {
                return {
                  ...prevState,
                  votes: {}, // Limpiar votos para la nueva votación
                  confirmedVotes: [],
                  players: prevState.players.map((player) => {
                    // Mantener el voto solo si votó a uno de los empatados
                    const playerVote = player.vote;
                    const tiedPlayersArray = Array.isArray(tiedPlayers) ? tiedPlayers : [];
                    const keptVote = playerVote && tiedPlayersArray.includes(playerVote) ? playerVote : undefined;
                    const { vote, ...rest } = player;
                    return { ...rest, vote: keptVote };
                  }),
                  phase: 'tiebreaker',
                  tiebreaker: {
                    tiedPlayers: [...tiedPlayers],
                    voteCount,
                    previousVotes: updatedVotes,
                  },
                  elimination: undefined,
                };
              }
              
              // Si hay un ganador, eliminar
              return finishElimination(
                { ...prevState, votes: updatedVotes, confirmedVotes: updatedConfirmedVotes },
                targetId,
                prevState.players
              );
            });
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      clearInterval(interval);
      // No resetear votingTimeRemaining aquí para mantener el valor
    };
  }, [gameState?.phase, gameState?.round, gameState?.votingTimeLimit, isHost, handleFinalizeVoting, patchState]);

  // Contador de 5 segundos cuando todos han dado su pista
  useEffect(() => {
    if (!gameState || gameState.phase !== 'clue') {
      setRevealCountdown(null);
      return;
    }

    // Verificar si todos los jugadores vivos han dado su pista
    const alivePlayers = getAlivePlayers(gameState);
    const cluesForCurrentRound = cluesForRound(gameState.clues, gameState.round);
    const allCluesGiven = alivePlayers.length > 0 && 
      alivePlayers.every((player) => cluesForCurrentRound.some((clue) => clue.playerId === player.id));

    if (!allCluesGiven) {
      setRevealCountdown(null);
      return;
    }

    // Iniciar contador de 5 segundos
    setRevealCountdown(5);

    const interval = setInterval(() => {
      setRevealCountdown((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(interval);
          // Si es el host, avanzar automáticamente a la fase de votación
          if (isHost && prev !== null && prev <= 1) {
            handleOpenVoting();
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      clearInterval(interval);
      setRevealCountdown(null);
    };
  }, [gameState?.phase, gameState?.clues, gameState?.round, gameState?.players, isHost, handleOpenVoting]);

  const handleContinueAfterReveal = useCallback(() => {
    if (!gameState || !isHost) return;
    if (gameState.phase !== 'reveal') return;

    patchState((prev) => {
      // Si el juego terminó (impostor ganó o civiles ganaron), volver al lobby
      if (prev.winner) {
        return {
          ...prev,
          phase: 'lobby' as GamePhase,
          votes: {},
          confirmedVotes: [],
          elimination: undefined,
          players: prev.players.map((player) => {
            const { clue, vote, ...rest } = player;
            return {
              ...rest,
              readyForRound: false,
            };
          }),
        };
      }

      const remainingPlayers = prev.players.map((player) => {
        const { clue, vote, ...rest } = player;
        return {
          ...rest,
          readyForRound: false,
        };
      });
      // Mantener el firstSpeakerIndex para que el orden se mantenga
      const nextState: GameState = {
        ...prev,
        phase: 'clue' as GamePhase,
        round: prev.round + 1,
        players: remainingPlayers,
        votes: {},
        confirmedVotes: [],
        elimination: undefined,
      };
      
      // Calcular el siguiente turno usando el firstSpeakerIndex guardado
      const nextIndex = nextSpeakerIndex({ ...nextState, currentTurnIndex: -1 });
      
      return {
        ...nextState,
        currentTurnIndex: nextIndex,
      };
    });
  }, [gameState, isHost, patchState]);

  // Efecto para deshabilitar scroll cuando estamos en la pantalla de revelación
  useEffect(() => {
    if (gameState?.phase === 'reveal' && gameState.elimination) {
      // Deshabilitar scroll en el body cuando estamos en reveal
      document.body.style.overflow = 'hidden';
    } else {
      // Restaurar scroll cuando salimos de reveal
      document.body.style.overflow = '';
    }

    return () => {
      // Limpiar al desmontar
      document.body.style.overflow = '';
    };
  }, [gameState?.phase, gameState?.elimination]);

  // Efecto para controlar la animación del texto de revelación
  useEffect(() => {
    // Manejar tanto reveal normal como reveal de empate
    if (gameState?.phase !== 'reveal') {
      // Resetear estados cuando salimos de reveal
      setRevealTextProgress(0);
      setShowResultScreen(false);
      return;
    }

    // Resetear estados al entrar en reveal
    setRevealTextProgress(0);
    setShowResultScreen(false);

    // Si hay eliminación, mostrar texto normal
    if (gameState.elimination) {
      const eliminated = gameState.players.find((player) => player.id === gameState.elimination?.targetId);
      const textToShow = eliminated && gameState.elimination.wasImpostor 
        ? 'era el impostor'
        : eliminated 
        ? 'era inocente'
        : '';

      if (!textToShow || !eliminated) return;

      const gameEnded = gameState.winner !== undefined;

      // Animar el texto letra por letra de forma fluida y consistente
      let currentIndex = 0;
      let animationFrameId: number | null = null;
      const targetInterval = 90; // 90ms por letra - ritmo más pausado pero fluido, mantiene el drama
      let startTime = performance.now();
      
      const animate = (currentTime: number) => {
        const elapsed = currentTime - startTime;
        const expectedIndex = Math.floor(elapsed / targetInterval);
        
        // Asegurar que el índice avance de forma consistente, sin saltos
        if (expectedIndex > currentIndex && expectedIndex <= textToShow.length) {
          currentIndex = expectedIndex;
          setRevealTextProgress(currentIndex);
        }

        if (currentIndex >= textToShow.length) {
          // Asegurar que el texto completo se muestre
          setRevealTextProgress(textToShow.length);
          
          // Después de 1 segundo de margen, mostrar pantalla de resultado con blur de salida
          setTimeout(() => {
            // Primero aplicar blur de salida a la pantalla anterior
            setShowResultScreen(true);
            
            // Si la partida continúa (no ha terminado), avanzar automáticamente después de 3 segundos
            if (!gameEnded && isHost) {
              setTimeout(() => {
                handleContinueAfterReveal();
              }, 3000);
            }
          }, 1000);
          return;
        }
        
        animationFrameId = requestAnimationFrame(animate);
      };

      animationFrameId = requestAnimationFrame(animate);

      return () => {
        if (animationFrameId !== null) {
          cancelAnimationFrame(animationFrameId);
        }
      };
    } else {
      // Si no hay eliminación, es un empate - mostrar "No se ha eliminado a nadie"
      const textToShow = 'No se ha eliminado a nadie';
      const gameEnded = gameState.winner !== undefined;

      // Animar el texto letra por letra
      let currentIndex = 0;
      let animationFrameId: number | null = null;
      const targetInterval = 90; // 90ms por letra - ritmo más pausado pero fluido, mantiene el drama
      let startTime = performance.now();
      
      const animate = (currentTime: number) => {
        const elapsed = currentTime - startTime;
        const expectedIndex = Math.floor(elapsed / targetInterval);
        
        // Asegurar que el índice avance de forma consistente, sin saltos
        if (expectedIndex > currentIndex && expectedIndex <= textToShow.length) {
          currentIndex = expectedIndex;
          setRevealTextProgress(currentIndex);
        }

        if (currentIndex >= textToShow.length) {
          // Asegurar que el texto completo se muestre
          setRevealTextProgress(textToShow.length);
          
          // Después de 1 segundo de margen, mostrar pantalla de resultado con blur de salida
          setTimeout(() => {
            // Primero aplicar blur de salida a la pantalla anterior
            setShowResultScreen(true);
            
            // Si la partida continúa (no ha terminado), avanzar automáticamente después de 3 segundos
            if (!gameEnded && isHost) {
              setTimeout(() => {
                handleContinueAfterReveal();
              }, 3000);
            }
          }, 1000);
          return;
        }
        
        animationFrameId = requestAnimationFrame(animate);
      };

      animationFrameId = requestAnimationFrame(animate);

      return () => {
        if (animationFrameId !== null) {
          cancelAnimationFrame(animationFrameId);
        }
      };
    }
  }, [gameState?.phase, gameState?.elimination, gameState?.players, gameState?.winner, isHost, handleContinueAfterReveal]);


  const handleSubmitClue = useCallback(
    (word: string) => {
      const trimmed = sanitizeWord(word);
      if (!trimmed) return;
      sendBroadcast('SUBMIT_CLUE', { playerId, word: trimmed } satisfies CluePayload);
    },
    [playerId, sendBroadcast],
  );

  const handleVote = useCallback(
    (targetId: string) => {
      // No permitir votar a uno mismo
      if (playerId === targetId) {
        setStatusMessage('No puedes votar a ti mismo.');
        return;
      }
      
      // Si el voto está confirmado, no permitir cambios
      const isVoteConfirmed = gameState?.confirmedVotes?.includes(playerId);
      if (isVoteConfirmed) {
        return; // No hacer nada, el voto está confirmado y bloqueado
      }
      
      // Si no se permite cambiar voto y ya hay un voto, bloquear cualquier cambio
      if (!gameState?.allowVoteChange && gameState?.votes[playerId]) {
        return; // No hacer nada, el voto está bloqueado
      }
      
      // Si ya está votado por esta persona, quitar el voto (solo si se permite cambiar)
      if (gameState?.allowVoteChange && gameState?.votes[playerId] === targetId) {
        sendBroadcast('CLEAR_VOTE', { playerId });
        return;
      }
      
      sendBroadcast('SUBMIT_VOTE', { voterId: playerId, targetId } satisfies VotePayload);
    },
    [playerId, sendBroadcast, gameState?.votes, gameState?.allowVoteChange, gameState?.confirmedVotes],
  );

  const handleConfirmVote = useCallback(() => {
    // Solo se puede confirmar si hay un voto y no está ya confirmado
    if (!gameState?.votes[playerId]) {
      setStatusMessage('Debes votar antes de confirmar.');
      return;
    }
    
    if (gameState?.confirmedVotes?.includes(playerId)) {
      return; // Ya está confirmado
    }
    
    sendBroadcast('CONFIRM_VOTE', { playerId });
  }, [playerId, sendBroadcast, gameState?.votes, gameState?.confirmedVotes]);

  // Manejar clic en pestaña de tiempo (comportamiento tipo switch)
  const handleTimeTabClick = (tab: 'turno' | 'votaciones') => {
    if (activeTimeTab === tab) {
      // Si se hace clic en la pestaña activa, deseleccionarla
      setActiveTimeTab(null);
    } else {
      // Activar la pestaña seleccionada (automáticamente deselecciona la otra)
      setActiveTimeTab(tab);
    }
  };

  // Manejar clic en botón de tiempo
  const handleTimeButtonClick = useCallback((value: number | undefined) => {
    if (activeTimeTab === 'turno') {
      setSelectedTimeLimit(value);
      // Guardar en gameState para que los no anfitriones lo vean
      if (isHost && gameState && patchState) {
        patchState((prev) => ({
          ...prev,
          timeLimit: value,
        }));
      }
    } else if (activeTimeTab === 'votaciones') {
      setSelectedVotingTimeLimit(value);
      // Guardar en gameState para que los no anfitriones lo vean
      if (isHost && gameState && patchState) {
        patchState((prev) => ({
          ...prev,
          votingTimeLimit: value,
        }));
      }
    }
  }, [activeTimeTab, isHost, gameState, patchState]);

  // Obtener el valor actual a mostrar en los botones
  const getCurrentTimeValue = (): number | undefined => {
    if (activeTimeTab === 'turno') {
      return selectedTimeLimit;
    } else if (activeTimeTab === 'votaciones') {
      return selectedVotingTimeLimit;
    }
    return undefined; // Si no hay pestaña activa, mostrar todas sin selección
  };

  // Formatear el valor de tiempo para mostrar (en minúscula y entre paréntesis)
  const formatTimeValue = (value: number | undefined): string => {
    if (value === undefined) return ' (sin límite)';
    return ` (${value}s)`;
  };

  const renderHome = () => (
    <div className="card">
      <h1>Impostor Online</h1>
      <div className="logo-container">
        <img src="/impostor-logo-3d.png" alt="Impostor Logo" className="logo-3d" />
      </div>
      <p className="subtitle">3 a 6 jugadores</p>
      
      <div className="field-centered">
        <input 
          value={playerName} 
          onChange={(event) => setPlayerName(event.target.value)} 
          placeholder="Tu nombre"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck="false"
          data-form-type="other"
          data-lpignore="true"
          data-1p-ignore="true"
        />
      </div>

      <div className="divider"></div>

      <div className="action-buttons">
        <button 
          type="button" 
          className="primary" 
          onClick={handleCreateRoom} 
          disabled={!playerName.trim() || !database}
        >
          Crear sala
        </button>
        
        <div className="join-section">
          <div
            id="room-code-input"
            className="join-input code-editable"
            contentEditable
            suppressContentEditableWarning
            data-placeholder="código"
            onInput={(e) => {
              const div = e.currentTarget;
              let text = div.textContent || '';
              // Formato: 1 letra (mayúscula) + 2 números
              let cleaned = '';
              for (let i = 0; i < text.length && cleaned.length < 3; i++) {
                const char = text[i];
                if (cleaned.length === 0) {
                  // Primer carácter: solo letra, convertir a mayúscula
                  if (/[A-Za-z]/.test(char)) {
                    cleaned += char.toUpperCase();
                  }
                } else {
                  // Siguientes caracteres: solo números
                  if (/[0-9]/.test(char)) {
                    cleaned += char;
                  }
                }
              }
              div.textContent = cleaned;
              setJoinCodeInput(cleaned);
              
              // Posicionar el cursor al final
              setTimeout(() => {
                const range = document.createRange();
                const selection = window.getSelection();
                range.selectNodeContents(div);
                range.collapse(false); // Colapsar al final
                selection?.removeAllRanges();
                selection?.addRange(range);
              }, 0);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              const div = e.currentTarget;
              const text = div.textContent || '';
              
              // Si es una tecla de control, permitirla
              if (['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab', 'Enter'].includes(e.key)) {
                return;
              }
              
              // Si ya hay 3 caracteres, no permitir más
              if (text.length >= 3) {
                e.preventDefault();
                return;
              }
              
              // Primer carácter: solo letra (convertir a mayúscula)
              if (text.length === 0) {
                if (/[A-Za-z]/.test(e.key)) {
                  e.preventDefault();
                  const upperKey = e.key.toUpperCase();
                  div.textContent = upperKey;
                  setJoinCodeInput(upperKey);
                  // Posicionar el cursor al final
                  setTimeout(() => {
                    const range = document.createRange();
                    const selection = window.getSelection();
                    range.selectNodeContents(div);
                    range.collapse(false); // Colapsar al final
                    selection?.removeAllRanges();
                    selection?.addRange(range);
                  }, 0);
                } else {
                  e.preventDefault();
                }
                return;
              }
              
              // Siguientes caracteres: solo números
              if (text.length >= 1) {
                if (/[0-9]/.test(e.key)) {
                  // Permitir el número
                  return;
                } else {
                  e.preventDefault();
                }
              }
            }}
            onPaste={(e) => {
              e.preventDefault();
              const text = (e.clipboardData || (window as any).clipboardData).getData('text');
              // Formato: 1 letra (mayúscula) + 2 números
              let cleaned = '';
              for (let i = 0; i < text.length && cleaned.length < 3; i++) {
                const char = text[i];
                if (cleaned.length === 0) {
                  // Primer carácter: solo letra, convertir a mayúscula
                  if (/[A-Za-z]/.test(char)) {
                    cleaned += char.toUpperCase();
                  }
                } else {
                  // Siguientes caracteres: solo números
                  if (/[0-9]/.test(char)) {
                    cleaned += char;
                  }
                }
              }
              e.currentTarget.textContent = cleaned;
              setJoinCodeInput(cleaned);
              // Posicionar el cursor al final
              setTimeout(() => {
                const div = e.currentTarget;
                const range = document.createRange();
                const selection = window.getSelection();
                range.selectNodeContents(div);
                range.collapse(false); // Colapsar al final
                selection?.removeAllRanges();
                selection?.addRange(range);
              }, 0);
            }}
            style={{
              textTransform: 'uppercase',
            }}
            onFocus={(e) => {
              e.stopPropagation();
              // Posicionar el cursor al final al enfocar
              setTimeout(() => {
                const div = e.currentTarget;
                const range = document.createRange();
                const selection = window.getSelection();
                if (div.textContent) {
                  range.selectNodeContents(div);
                  range.collapse(false); // Colapsar al final
                  selection?.removeAllRanges();
                  selection?.addRange(range);
                }
              }, 0);
            }}
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              // Posicionar el cursor al final al hacer clic
              setTimeout(() => {
                const div = e.currentTarget;
                const range = document.createRange();
                const selection = window.getSelection();
                if (div.textContent) {
                  range.selectNodeContents(div);
                  range.collapse(false); // Colapsar al final
                  selection?.removeAllRanges();
                  selection?.addRange(range);
                }
              }, 0);
            }}
          />
          <input
            type="hidden"
            id="room-code-hidden"
            value={joinCodeInput}
            readOnly
            tabIndex={-1}
            style={{ position: 'absolute', left: '-9999px', opacity: 0, pointerEvents: 'none' }}
          />
          <button
            type="button"
            className="secondary join-button"
            onClick={handleJoinRoom}
            disabled={!playerName.trim() || joinCodeInput.trim().length !== 3 || !/^[A-Z][0-9]{2}$/.test(joinCodeInput.trim().toUpperCase())}
          >
            Unirse
          </button>
        </div>

        <button 
          type="button" 
          className="secondary" 
          onClick={() => setIsLocalMode(true)}
          disabled={!playerName.trim()}
        >
          Jugar en este dispositivo
        </button>
      </div>

      {!database && (
        <p className="warning">
          Configura las variables de entorno de Firebase (VITE_FIREBASE_*) para usar el modo online.
        </p>
      )}

      <div className="credits">
        <div className="credits-links">
          <a href="https://github.com/arnau-sala/" target="_blank" rel="noopener noreferrer" className="credit-link">GitHub</a>
          <a 
            href="https://instagram.com/arnausaala" 
            onClick={(e) => {
              const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera;
              const isAndroid = /android/i.test(userAgent);
              const isIOS = /iPad|iPhone|iPod/.test(userAgent) && !(window as any).MSStream;
              
              let appUrl = '';
              const webUrl = 'https://instagram.com/arnausaala';
              
              if (isAndroid) {
                // Android intent URL
                appUrl = `intent://instagram.com/_u/arnausaala/#Intent;package=com.instagram.android;scheme=https;end`;
              } else if (isIOS) {
                // iOS URL scheme
                appUrl = 'instagram://user?username=arnausaala';
              } else {
                // Desktop - abrir directamente en web
                return;
              }
              
              // Intentar abrir la app
              const iframe = document.createElement('iframe');
              iframe.style.display = 'none';
              iframe.src = appUrl;
              document.body.appendChild(iframe);
              
              // Si la app no se abre, abrir en web después de un tiempo
              setTimeout(() => {
                document.body.removeChild(iframe);
                window.open(webUrl, '_blank', 'noopener,noreferrer');
              }, 1000);
              
              e.preventDefault();
            }}
            target="_blank"
            rel="noopener noreferrer"
            className="credit-link"
          >
            Instagram
          </a>
          <a href="mailto:arnausalaaraujo@gmail.com?subject=[De Impostor]" className="credit-link">Email</a>
          <a href="https://github.com/arnau-sala/impostor/issues/new" target="_blank" rel="noopener noreferrer" className="credit-link">Feedback</a>
        </div>
      </div>
    </div>
  );

  // ========== MODO LOCAL (UN SOLO DISPOSITIVO) ==========
  
  const handleAddLocalPlayer = () => {
    const trimmed = sanitizeName(localPlayerInput);
    if (!trimmed) return;
    if (localPlayers.length >= 6) {
      setStatusMessage('Máximo 6 jugadores.');
      return;
    }
    if (localPlayers.some(name => name.toLowerCase() === trimmed.toLowerCase())) {
      setStatusMessage('Ese nombre ya está en la lista.');
      return;
    }
    setLocalPlayers([...localPlayers, trimmed]);
    setLocalPlayerInput('');
  };

  const handleRemoveLocalPlayer = (index: number) => {
    setLocalPlayers(localPlayers.filter((_, i) => i !== index));
  };

  const handleStartLocalConfig = () => {
    if (localPlayers.length < 3) {
      setStatusMessage('Se necesitan al menos 3 jugadores.');
      return;
    }
    setLocalPhase('config');
    setStatusMessage(null);
  };

  const handleStartLocalGame = () => {
    if (!selectedTopicId) {
      setStatusMessage('Selecciona una temática.');
      return;
    }

    const selectedTopic = topics[selectedTopicId];
    const randomPlayer = getRandomPlayerForTopic(selectedTopicId);
    if (!randomPlayer) {
      setStatusMessage('No hay jugadores disponibles para esta temática.');
      return;
    }

    // Crear jugadores con IDs únicos
    const players = localPlayers.map((name, index) => ({
      id: `local-${index}-${Date.now()}`,
      name,
      isImpostor: false,
    }));

    // Seleccionar impostor aleatoriamente
    const impostorIndex = Math.floor(Math.random() * players.length);
    const impostorId = players[impostorIndex].id;
    players[impostorIndex].isImpostor = true;

    // Seleccionar primer hablante aleatoriamente
    const firstSpeakerIndex = Math.floor(Math.random() * players.length);

    setLocalGameState({
      topic: selectedTopic.name,
      secretWord: randomPlayer.name,
      selectedPlayerClue: randomPlayer.clue,
      showClue: showClueOption,
      impostorId,
      players,
      firstSpeakerIndex,
    });

    setCurrentLocalPlayerIndex(0);
    setLocalPhase('reveal');
    setStatusMessage(null);
  };

  const handleNextLocalPlayer = () => {
    if (currentLocalPlayerIndex < localPlayers.length - 1) {
      setCurrentLocalPlayerIndex(currentLocalPlayerIndex + 1);
      setIsHoldingReveal(false);
      setHasRevealedOnce(false); // Reset para el siguiente jugador
    } else {
      // Último jugador, pasar a la fase de juego
      setLocalPhase('game');
      setIsHoldingReveal(false);
      setHasRevealedOnce(false);
    }
  };

  const handleNewLocalGame = () => {
    // Mantener la lista de jugadores pero resetear el resto
    setLocalPlayerInput('');
    setCurrentLocalPlayerIndex(0);
    setLocalGameState(null);
    setLocalPhase('config'); // Ir directamente a configuración
    setSelectedTopicId(null);
    setShowClueOption(true);
    setIsHoldingReveal(false);
    setHasRevealedOnce(false);
    setStatusMessage(null);
  };

  const renderLocalPlayers = () => (
    <div className="card">
      <header className="header">
        <h2>Jugadores</h2>
        <button type="button" className="close-button" onClick={() => setIsLocalMode(false)} aria-label="Cerrar">
          ×
        </button>
      </header>
      <p style={{ textAlign: 'center', color: '#a5b4fc', marginBottom: '20px', marginTop: '40px' }}>
        Introduce los nombres de los jugadores (3-6)
      </p>
      
      <div style={{ marginBottom: '12px', display: 'flex', gap: '8px', alignItems: 'center' }}>
        <input
          value={localPlayerInput}
          onChange={(event) => setLocalPlayerInput(event.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleAddLocalPlayer();
            }
          }}
          placeholder=" Nombre del jugador"
          
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck="false"
          maxLength={20}
          style={{
            height: '28px',
            padding: '4px 8px',
            fontSize: '0.9rem',
            flex: 1
          }}
        />
        <button
          type="button"
          className="button"
          onClick={handleAddLocalPlayer}
          disabled={!localPlayerInput.trim() || localPlayers.length >= 6}
          style={{
            minHeight: '54px',
            height: '54px',
            padding: '2px 8px',
            fontSize: '0.75rem',
            minWidth: '120px',
            width: '120px',
            color: '666',
          }}
        >
          Añadir
        </button>
      </div>

      {localPlayers.length > 0 && (
        <section style={{ marginBottom: '20px' }}>
          <h3 style={{ fontSize: '1rem', marginBottom: '12px', color: '#e0e7ff' }}>Lista de jugadores ({localPlayers.length}/6)</h3>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {localPlayers.map((name, index) => (
              <li key={index} style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                marginBottom: '6px',
                backgroundColor: 'rgba(139, 92, 246, 0.1)',
                borderRadius: '6px',
                border: '1px solid rgba(139, 92, 246, 0.2)',
                position: 'relative'
              }}>
                <span style={{ color: '#e0e7ff', fontWeight: 500 }}>{name}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveLocalPlayer(index)}
                  style={{
                    position: 'absolute',
                    right: '8px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    color: '#ef4444',
                    cursor: 'pointer',
                    fontSize: '1.2rem',
                    lineHeight: 1,
                    padding: '2px',
                    width: '20px',
                    height: '20px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: '50%',
                    transition: 'background-color 0.2s ease'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.2)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="footer">
        <button 
          type="button" 
          className="button primary" 
          onClick={handleStartLocalConfig}
          disabled={localPlayers.length < 3}
        >
          Empezar partida
        </button>
      </footer>
    </div>
  );

  const renderLocalConfig = () => (
    <div className="card">
      <header className="header">
        <h2>Configuración de la partida</h2>
        <button type="button" className="close-button" onClick={() => setLocalPhase('players')} aria-label="Volver">
          ×
        </button>
      </header>
      
      <section style={{ marginBottom: '24px' }}>
        <h3 style={{ fontSize: '1rem', marginBottom: '12px', color: '#e0e7ff', marginTop: '20px'}}>Temática</h3>
        <div className="topic-buttons">
          {Object.values(topics).map((topic) => (
            <button
              key={topic.id}
              type="button"
              className={`topic-button ${selectedTopicId === topic.id ? 'selected' : ''}`}
              onClick={() => setSelectedTopicId(topic.id)}
              disabled={!topic.hasPlayers}
            >
              <span className="topic-icon">
                <img
                  src={`/${topic.id}.png`}
                  alt={topic.name}
                  className="topic-icon-img"
                />
              </span>
              <span className="topic-name">{topic.name}</span>
            </button>
          ))}
        </div>
      </section>

      <section style={{ marginBottom: '24px' }}>
        <h3 style={{ fontSize: '1rem', marginBottom: '12px', color: '#e0e7ff' }}>Pista</h3>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            type="button"
            className={`button ${showClueOption ? 'primary' : ''}`}
            onClick={() => setShowClueOption(true)}
            style={{ flex: 1 }}
          >
            Sí
          </button>
          <button
            type="button"
            className={`button ${!showClueOption ? 'primary' : ''}`}
            onClick={() => setShowClueOption(false)}
            style={{ flex: 1 }}
          >
            No
          </button>
        </div>
      </section>

      <footer className="footer">
        <button 
          type="button" 
          className="button primary" 
          onClick={handleStartLocalGame}
          disabled={!selectedTopicId}
        >
          Empezar partida
        </button>
      </footer>
    </div>
  );

  const renderLocalReveal = () => {
    if (!localGameState) return null;
    
    const currentPlayer = localGameState.players[currentLocalPlayerIndex];
    const isImpostor = currentPlayer.id === localGameState.impostorId;
    const isLastPlayer = currentLocalPlayerIndex === localPlayers.length - 1;

    return (
      <div className="card">
        <header className="header" style={{justifyContent: 'center', marginTop: '20px'}}>
          <h2>{currentPlayer.name}</h2>
        </header>
        
        <section className="reveal" style={{ minHeight: '300px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
          <p style={{ fontSize: '1.2rem', color: '#a5b4fc', textAlign: 'center', marginBottom: '20px' }}>
            Haz clic para ver la palabra
          </p>

          {/* Recuadro único que cambia de contenido */}
          <div
            style={{
              width: '300px',
              height: '300px',
              borderRadius: '12px',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'center',
              cursor: 'pointer',
              userSelect: 'none',
              touchAction: 'manipulation',
              marginTop: '20px',
            }}
            onClick={() => {
              if (!hasRevealedOnce) {
                setHasRevealedOnce(true);
              }
              setIsHoldingReveal(!isHoldingReveal);
            }}
          >
            {isHoldingReveal ? (
              // Contenido revelado
              isImpostor ? (
                <div style={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  alignItems: 'center',
                  borderRadius: '12px',
                  backgroundColor: 'rgba(239, 68, 68, 0.1)',
                  border: '2px solid rgba(239, 68, 68, 0.3)',
                }}>
                  <h3 style={{ margin: '0 0 10px 0', fontSize: '1.1rem' }}>
                    {localGameState.showClue && localGameState.selectedPlayerClue ? (
                      <>Pista: <span style={{ fontWeight: 'normal', fontSize: '0.9em' }}>{localGameState.selectedPlayerClue}</span></>
                    ) : (
                      'No hay pista'
                    )}
                  </h3>
                  <p className="keyword" style={{ fontSize: '1.8rem', margin: 0 }}>IMPOSTOR</p>
                </div>
              ) : (
                <div style={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  alignItems: 'center',
                  borderRadius: '12px',
                  backgroundColor: 'rgba(139, 92, 246, 0.1)',
                  border: '2px solid rgba(139, 92, 246, 0.3)',
                }}>
                  <h3 style={{ margin: '0 0 10px 0', fontSize: '1.1rem' }}>Jugador secreto</h3>
                  <p className="keyword" style={{ fontSize: '1.8rem', margin: 0 }}>{localGameState.secretWord}</p>
                </div>
              )
            ) : (
              // Recuadro inicial
              <div style={{
                width: '100%',
                height: '100%',
                border: '2px dashed rgba(139, 92, 246, 0.4)',
                borderRadius: '12px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: 'rgba(139, 92, 246, 0.05)',
              }}>
                <span style={{ color: '#6b7280', fontSize: '0.9rem' }}>Haz clic aquí</span>
              </div>
            )}
          </div>
        </section>

        {hasRevealedOnce && (
          <footer className="footer">
            <button 
              type="button" 
              className="button primary" 
              onClick={handleNextLocalPlayer}
            >
              {isLastPlayer ? 'Jugar' : 'Siguiente jugador'}
            </button>
          </footer>
        )}
      </div>
    );
  };

  const renderLocalGame = () => {
    if (!localGameState) return null;
    
    const firstSpeaker = localGameState.players[localGameState.firstSpeakerIndex];

    return (
      <div className="card">
        <header className="header" style={{justifyContent: 'center'}}>
          <h2>¡Empieza la partida!</h2>
        </header>
        
        <section style={{ textAlign: 'center', padding: '40px 20px' }}>
          <p style={{ fontSize: '1.2rem', color: '#a5b4fc', marginBottom: '20px' }}>
            El primer jugador en hablar es:
          </p>
          <h2 style={{ fontSize: '2rem', color: '#e0e7ff', marginBottom: '30px' }}>
            {firstSpeaker.name}
          </h2>
          <p style={{ fontSize: '1rem', color: '#6b7280' }}>
            Los jugadores se encargarán de gestionar los turnos y las votaciones.
          </p>
        </section>

        <footer className="footer">
          <button 
            type="button" 
            className="button primary" 
            onClick={handleNewLocalGame}
          >
            Nueva partida
          </button>
        </footer>
      </div>
    );
  };

  const renderLobby = () => {
    // Si no hay gameState pero hay roomCode, mostrar estado de carga
    if (!gameState) {
      return (
        <div className="card">
          <header className="header">
            <h2>Cargando sala...</h2>
          </header>
          <p className="waiting">Preparando la sala...</p>
        </div>
      );
    }
    
    const hostPlayer = gameState.players.find((player) => player.id === gameState.hostId);
    const isCurrentHost = hostPlayer?.id === playerId;

    return (
      <div className="card">
        <header className="header">
          <button type="button" className="close-button" onClick={handleLeaveRoom} aria-label="Cerrar">
            ×
          </button>
        </header>
        <section className="room-code-section">
          <p className="room-code-label">Código de sala</p>
          <div className="room-code-display">{gameState.code}</div>
          {isCurrentHost && <p className="room-code-hint">Comparte este código para invitar a tus amigos</p>}
        </section>
        <section className="players">
          <h3>Jugadores ({gameState.players.length}/{MAX_PLAYERS})</h3>
          <ul className="non-interactive">
            {gameState.players.map((player) => (
              <li key={player.id}>
                <span>{player.name}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {player.id === playerId && <span className="badge badge-you">Tú</span>}
                  {player.id === gameState.hostId && <span className="badge">Anfitrión</span>}
                </div>
              </li>
            ))}
          </ul>
        </section>
        {isCurrentHost ? (
          <section className="host-panel">
            <label className="field">
              <span>Temática</span>
              <div className="topic-buttons">
                {Object.values(topics).map((topic) => (
                  <button
                    key={topic.id}
                    type="button"
                    className={`topic-button ${selectedTopicId === topic.id ? 'selected' : ''}`}
                    onClick={() => {
                      const newTopicId = topic.id;
                      setSelectedTopicId(newTopicId);
                      // Guardar en gameState para que los no anfitriones lo vean
                      if (isHost && gameState && patchState) {
                        patchState((prev) => ({
                          ...prev,
                          topic: topic.name,
                        }));
                      }
                    }}
                    disabled={!topic.hasPlayers}
                  >
                    <span className="topic-icon">
                      <img 
                        src={`/${topic.id}.png`} 
                        alt={topic.name}
                        className="topic-icon-img"
                      />
                    </span>
                    <span className="topic-name">{topic.name}</span>
                  </button>
                ))}
              </div>
            </label>
            <label className="field personalization-field">
              <span>PERSONALIZACIÓN</span>
              <div className="personalization-grid">
              <div 
                  className={`personalization-button ${showClueOption ? 'active' : 'inactive'}`}
                onClick={() => {
                  const newValue = !showClueOption;
                  setShowClueOption(newValue);
                  // Guardar en gameState para que los no anfitriones lo vean
                  if (isHost && gameState && patchState) {
                    patchState((prev) => ({
                      ...prev,
                      showClue: newValue,
                    }));
                  }
                }}
              >
                  <div className="personalization-icon">
                    <img 
                      src={showClueOption ? "/pista.png" : "/sinPista.png"} 
                      alt={showClueOption ? "Pista activada" : "Pista desactivada"}
                      className="personalization-icon-img"
                  />
                </div>
                  <span className="personalization-label">
                    {showClueOption ? 'Pista' : 'Sin pista'}
                </span>
                </div>
                <div 
                  className={`personalization-button ${allowVoteChangeOption ? 'active' : 'inactive'}`}
                  onClick={() => {
                    const newValue = !allowVoteChangeOption;
                    setAllowVoteChangeOption(newValue);
                    // Guardar en gameState para que los no anfitriones lo vean
                    if (isHost && gameState && patchState) {
                      patchState((prev) => ({
                        ...prev,
                        allowVoteChange: newValue,
                      }));
                    }
                  }}
                >
                  <div className="personalization-icon">
                    <img 
                      src={allowVoteChangeOption ? "/cambioVoto.png" : "/sinCambioVoto.png"} 
                      alt={allowVoteChangeOption ? "Cambiar voto activado" : "Cambiar voto desactivado"}
                      className="personalization-icon-img"
                    />
                  </div>
                  <span className="personalization-label">
                    {allowVoteChangeOption ? 'Cambiar voto' : 'Sin cambio'}
                  </span>
                </div>
                <div 
                  className={`personalization-button ${!singleWordOnlyOption ? 'active' : 'inactive'}`}
                  onClick={() => {
                    const newValue = !singleWordOnlyOption;
                    setSingleWordOnlyOption(newValue);
                    // Guardar en gameState para que los no anfitriones lo vean
                    if (isHost && gameState && patchState) {
                      patchState((prev) => ({
                        ...prev,
                        singleWordOnly: newValue,
                      }));
                    }
                  }}
                >
                  <div className="personalization-icon">
                    <img 
                      src={!singleWordOnlyOption ? "/masDeUnaPalabra.png" : "/soloUnaPalabra.png"} 
                      alt={!singleWordOnlyOption ? "Palabras" : "Una palabra"}
                      className="personalization-icon-img"
                    />
                  </div>
                  <span className="personalization-label">
                    {!singleWordOnlyOption ? 'Palabras' : 'Una palabra'}
                  </span>
                </div>
                <div 
                  className={`personalization-button ${voteDisplayModeOption !== 'hidden' ? 'active' : 'inactive'}`}
                  onClick={() => {
                    // Ciclar entre los 3 estados: hidden -> count -> visible -> hidden
                    const nextMode = voteDisplayModeOption === 'hidden' 
                      ? 'count' 
                      : voteDisplayModeOption === 'count' 
                      ? 'visible' 
                      : 'hidden';
                    setVoteDisplayModeOption(nextMode);
                    // Guardar en gameState para que los no anfitriones lo vean
                    if (isHost && gameState && patchState) {
                      patchState((prev) => ({
                        ...prev,
                        voteDisplayMode: nextMode,
                      }));
                    }
                  }}
                >
                  <div className="personalization-icon">
                    <img 
                      src={
                        voteDisplayModeOption === 'hidden' 
                          ? "/votosOcultos.png" 
                          : voteDisplayModeOption === 'count' 
                          ? "/recuentoVisible.png" 
                          : "/votosVisibles.png"
                      } 
                      alt={
                        voteDisplayModeOption === 'hidden' 
                          ? "Votos ocultos" 
                          : voteDisplayModeOption === 'count' 
                          ? "Recuento" 
                          : "Votos visibles"
                      }
                      className="personalization-icon-img"
                    />
                  </div>
                  <span className="personalization-label">
                    {voteDisplayModeOption === 'hidden' 
                      ? 'Votos ocultos' 
                      : voteDisplayModeOption === 'count' 
                      ? 'Recuento' 
                      : 'Votos visibles'}
                  </span>
                </div>
              </div>
            </label>
            <label className="field">
              <span>Tiempo</span>
              <div 
                className="time-tabs"
                data-active={activeTimeTab || 'none'}
              >
                <div className="time-tab-container">
                  <button
                    type="button"
                    className={`time-tab ${activeTimeTab === 'turno' ? 'active' : ''}`}
                    onClick={() => handleTimeTabClick('turno')}
                  >
                    Turno{formatTimeValue(selectedTimeLimit)}
                  </button>
                </div>
                <div className="time-tab-container">
                  <button
                    type="button"
                    className={`time-tab ${activeTimeTab === 'votaciones' ? 'active' : ''}`}
                    onClick={() => handleTimeTabClick('votaciones')}
                  >
                    Votaciones{formatTimeValue(selectedVotingTimeLimit)}
                  </button>
                </div>
              </div>
              <div className="time-buttons">
                <button
                  type="button"
                  className={`time-button ${activeTimeTab !== null && getCurrentTimeValue() === undefined ? 'selected' : ''}`}
                  onClick={() => handleTimeButtonClick(undefined)}
                  disabled={activeTimeTab === null}
                >
                  Sin límite
                </button>
                <button
                  type="button"
                  className={`time-button ${activeTimeTab !== null && getCurrentTimeValue() === 15 ? 'selected' : ''}`}
                  onClick={() => handleTimeButtonClick(15)}
                  disabled={activeTimeTab === null}
                >
                  15s
                </button>
                <button
                  type="button"
                  className={`time-button ${activeTimeTab !== null && getCurrentTimeValue() === 30 ? 'selected' : ''}`}
                  onClick={() => handleTimeButtonClick(30)}
                  disabled={activeTimeTab === null}
                >
                  30s
                </button>
                <button
                  type="button"
                  className={`time-button ${activeTimeTab !== null && getCurrentTimeValue() === 60 ? 'selected' : ''}`}
                  onClick={() => handleTimeButtonClick(60)}
                  disabled={activeTimeTab === null}
                >
                  60s
                </button>
              </div>
            </label>
            <button
              type="button"
              className="primary"
              onClick={handleStartGame}
              disabled={gameState.players.length < MIN_PLAYERS || !selectedTopicId || !topics[selectedTopicId]?.hasPlayers}
            >
              Empezar partida
            </button>
          </section>
        ) : (
          <section className="guest-summary">
            <h3>Configuración de la partida</h3>
            <div className="summary-container">
              <div className="summary-topic-card">
                {gameState.topic && Object.values(topics).find(t => t.name === gameState.topic) ? (
                  <>
                    <div className="summary-topic-icon">
                        <img 
                          src={`/${Object.values(topics).find(t => t.name === gameState.topic)!.id}.png`} 
                          alt={gameState.topic}
                          className="summary-topic-icon-img"
                        />
                    </div>
                    <span className="summary-topic-name">{gameState.topic}</span>
                  </>
                ) : (
                  <span className="summary-topic-name summary-topic-name-centered">Categoría no seleccionada</span>
                )}
              </div>
              <div className="summary-options-grid">
                <div className="summary-option-card">
                  <div className="summary-option-icon">
                    <img 
                      src={gameState.showClue ? "/pista.png" : "/sinPista.png"} 
                      alt={gameState.showClue ? "Pista activada" : "Pista desactivada"}
                      className="summary-option-icon-img"
                    />
                  </div>
                  <span className="summary-option-label">{gameState.showClue ? 'Con pista' : 'Sin pista'}</span>
                </div>
                <div className="summary-option-card">
                  <div className="summary-option-icon">
                    <img 
                      src={gameState.allowVoteChange ? "/cambioVoto.png" : "/sinCambioVoto.png"} 
                      alt={gameState.allowVoteChange ? "Cambiar voto activado" : "Cambiar voto desactivado"}
                      className="summary-option-icon-img"
                    />
                  </div>
                  <span className="summary-option-label">{gameState.allowVoteChange ? 'Cambiar voto' : 'Sin cambio'}</span>
                </div>
                <div className="summary-option-card">
                  <div className="summary-option-icon">
                    <img 
                      src={gameState.singleWordOnly ? "/soloUnaPalabra.png" : "/masDeUnaPalabra.png"} 
                      alt={gameState.singleWordOnly ? "Una palabra" : "Palabras"}
                      className="summary-option-icon-img"
                    />
                  </div>
                  <span className="summary-option-label">{gameState.singleWordOnly ? 'Una palabra' : 'Palabras'}</span>
                </div>
                <div className="summary-option-card">
                  <div className="summary-option-icon">
                    <img 
                      src={
                        gameState.voteDisplayMode === 'hidden' 
                          ? "/votosOcultos.png" 
                          : gameState.voteDisplayMode === 'count' 
                          ? "/recuentoVisible.png" 
                          : "/votosVisibles.png"
                      } 
                      alt={
                        gameState.voteDisplayMode === 'hidden' 
                          ? "Votos ocultos" 
                          : gameState.voteDisplayMode === 'count' 
                          ? "Recuento" 
                          : "Votos visibles"
                      }
                      className="summary-option-icon-img"
                    />
                  </div>
                  <span className="summary-option-label">
                    {gameState.voteDisplayMode === 'hidden' 
                      ? 'Votos ocultos' 
                      : gameState.voteDisplayMode === 'count' 
                      ? 'Recuento' 
                      : 'Votos visibles'}
                  </span>
                </div>
                <div className="summary-option-card time-card">
                  <div className="summary-option-icon">
                    <img 
                      src="/turno.png" 
                      alt="Turno"
                      className="summary-option-icon-img"
                    />
                  </div>
                  <span className="summary-option-label">
                    {gameState.timeLimit !== undefined ? `${gameState.timeLimit}s` : 'Sin límite'}
                  </span>
                </div>
                <div className="summary-option-card time-card">
                  <div className="summary-option-icon">
                    <img 
                      src="/votacion.png" 
                      alt="Votación"
                      className="summary-option-icon-img"
                    />
                  </div>
                  <span className="summary-option-label">
                    {gameState.votingTimeLimit !== undefined ? `${gameState.votingTimeLimit}s` : 'Sin límite'}
                  </span>
                </div>
              </div>
            </div>
            <p className="waiting">Esperando a que el anfitrión inicie la partida…</p>
          </section>
        )}
      </div>
    );
  };

  const renderWordReveal = () => {
    if (!gameState || !currentPlayer) return null;

    const playerOrder = getPlayerOrder(gameState);
    
    // Usar impostorId como fuente de verdad única para determinar si el jugador es impostor
    // Esto asegura consistencia incluso si isImpostor no está sincronizado
    const isImpostor = gameState.impostorId ? currentPlayer.id === gameState.impostorId : false;

    return (
      <div className="card">
        <header className="header">
          <button type="button" className="close-button" onClick={handleLeaveRoom} aria-label="Cerrar">
            ×
          </button>
        </header>
        <section className="reveal">
          <p className="topic">Temática: <strong>{gameState.topic}</strong></p>
          {isImpostor ? (
            <div className="impostor-card">
              <h3>
                {gameState.showClue && gameState.selectedPlayerClue ? (
                  <>Pista: <span style={{ fontWeight: 'normal', fontSize: '0.9em' }}>{gameState.selectedPlayerClue}</span></>
                ) : (
                  'No hay pista'
                )}
              </h3>
              <p className="keyword">IMPOSTOR</p>
            </div>
          ) : (
            <div className="keyword-card">
              <h3>Jugador secreto</h3>
              <p className="keyword">{gameState.secretWord}</p>
            </div>
          )}
          {countdown !== null && (
            <div className="countdown-container">
              <p className="countdown-label">Empezando en...</p>
              <div className="countdown-number">{countdown}</div>
            </div>
          )}
          <div className="player-order-container">
            <p className="player-order-label">Orden de turnos:</p>
            <div className="player-order-list">
              {playerOrder.map((player, index) => (
                <div key={player.id} className="player-order-item">
                  <span className="player-order-number">{index + 1}.</span>
                  <span className="player-order-name">{player.name}</span>
                  {player.id === playerId && <span className="badge badge-you">Tú</span>}
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    );
  };

  const renderCluePhase = () => {
    if (!gameState || !currentPlayer) return null;
    const turnPlayer = gameState.currentTurnIndex >= 0 ? gameState.players[gameState.currentTurnIndex] : null;
    const isMyTurn = turnPlayer?.id === playerId;
    const handleClueSubmit = (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      handleSubmitClue(clueInput);
      setClueInput('');
      clueInputRef.current = '';
    };

    // Función helper para calcular el color del progreso basado en el tiempo restante
    const getProgressColor = (remaining: number, total: number): string => {
      const percentage = remaining / total;
      if (percentage > 0.5) {
        // Más de la mitad: morado
        return 'linear-gradient(90deg, rgba(139, 92, 246, 0.8) 0%, rgba(99, 102, 241, 0.8) 50%, rgba(139, 92, 246, 0.8) 100%)';
      } else {
        // Menos de la mitad: transición de morado a rojo
        const redFactor = 1 - (percentage * 2); // 0 a 1 cuando percentage va de 0.5 a 0
        const r = Math.round(139 + (239 - 139) * redFactor);
        const g = Math.round(92 + (68 - 92) * redFactor);
        const b = Math.round(246 + (68 - 246) * redFactor);
        return `linear-gradient(90deg, rgba(${r}, ${g}, ${b}, 0.8) 0%, rgba(${Math.round(r * 0.7)}, ${Math.round(g * 0.7)}, ${Math.round(b * 0.7)}, 0.8) 50%, rgba(${r}, ${g}, ${b}, 0.8) 100%)`;
      }
    };

    // Usar la misma función getPlayerOrder para garantizar consistencia
    const playerOrder = getPlayerOrder(gameState);
    const alivePlayers = playerOrder.filter(p => p.alive);
    const cluesMap = new Map(cluesCurrentRound.map(clue => [clue.playerId, clue.word]));
    
    // Obtener todas las pistas de todas las rondas anteriores (hasta la ronda actual - 1)
    const allPreviousClues = gameState.clues.filter(clue => clue.round < gameState.round);
    
    // Agrupar pistas anteriores por jugador y ordenar por ronda
    const previousCluesByPlayer = new Map<string, Array<{ word: string; round: number; createdAt: number }>>();
    allPreviousClues.forEach(clue => {
      if (!previousCluesByPlayer.has(clue.playerId)) {
        previousCluesByPlayer.set(clue.playerId, []);
      }
      previousCluesByPlayer.get(clue.playerId)!.push({
        word: clue.word,
        round: clue.round,
        createdAt: clue.createdAt
      });
    });
    
    // Ordenar las pistas de cada jugador por ronda (orden cronológico)
    previousCluesByPlayer.forEach((clues) => {
      clues.sort((a, b) => a.round - b.round || a.createdAt - b.createdAt);
    });
    
    // Función para obtener el texto a mostrar (pista o "-" o "[SIN RESPUESTA]")
    const getClueText = (playerId: string): string => {
      const clue = cluesMap.get(playerId);
      if (clue) return clue;
      return '-';
    };
    
    // Función para obtener las palabras anteriores de un jugador
    const getPreviousWords = (playerId: string): string[] => {
      const previousWords = previousCluesByPlayer.get(playerId) || [];
      return previousWords.map(w => w.word);
    };

    // Calcular número de impostores
    const impostorCount = gameState.players.filter(p => p.isImpostor).length;

    return (
      <div className="card">
        <header className="header">
          <div>
            <h2>Ronda {gameState.round}</h2>
            <p className="subtitle">Tema: {gameState.topic}</p>
          </div>
          <button type="button" className="close-button" onClick={handleLeaveRoom} aria-label="Cerrar">
            ×
          </button>
        </header>
        <div className="game-info-bar" style={{ marginBottom: '4px' }}>
          <div className="info-item">
            <span className="info-label">Impostores:</span>
            <span className="info-value">{impostorCount}</span>
          </div>
          <div className="info-divider"></div>
          <div className="info-item">
            <span className="info-label">Pista:</span>
            <span className="info-value">{gameState.showClue ? 'Sí' : 'No'}</span>
          </div>
          <div className="info-divider"></div>
          <div className="info-item">
            <span className="info-label">Respuestas:</span>
            <span className="info-value">{gameState.timeLimit ? `${gameState.timeLimit}s` : 'Sin límite'}</span>
          </div>
        </div>
        <div 
          className="game-info-bar"
          style={{
            cursor: 'pointer',
            userSelect: 'none',
            touchAction: 'manipulation',
            background: isHoldingSecretWord ? 'rgba(139, 92, 246, 0.15)' : 'rgba(139, 92, 246, 0.06)',
            borderColor: isHoldingSecretWord ? 'rgba(139, 92, 246, 0.3)' : 'rgba(139, 92, 246, 0.15)',
            transition: 'background 0.2s ease, border-color 0.2s ease',
            margin: '0 0 12px 0'
          }}
          onMouseDown={() => setIsHoldingSecretWord(true)}
          onMouseUp={() => setIsHoldingSecretWord(false)}
          onMouseLeave={() => setIsHoldingSecretWord(false)}
          onTouchStart={() => setIsHoldingSecretWord(true)}
          onTouchEnd={() => setIsHoldingSecretWord(false)}
          onTouchCancel={() => setIsHoldingSecretWord(false)}
        >
          <div className="info-item" style={{ flex: 1, justifyContent: 'center' }}>
            {isHoldingSecretWord ? (
              <span className="info-value" style={{ fontSize: '0.8rem' }}>
                {(() => {
                  const isImpostor = currentPlayer.isImpostor || (gameState.impostorId && currentPlayer.id === gameState.impostorId);
                  return isImpostor
                    ? `IMPOSTOR${gameState.showClue && gameState.selectedPlayerClue ? ` (${gameState.selectedPlayerClue})` : ''}`
                    : gameState.secretWord;
                })()}
              </span>
            ) : (
              <span className="info-label" style={{ fontSize: '0.8rem' }}>
                Mantén presionado para mostrar jugador
              </span>
            )}
          </div>
        </div>
        <h3 style={{ textAlign: 'center', margin: '16px 0 12px 0', color: '#e0e7ff' }}>Respuestas</h3>
        <section className="clues">
          <ul>
            {alivePlayers.map((player) => {
              const isAuthor = player.id === playerId;
              const clueWord = getClueText(player.id);
              const previousWords = getPreviousWords(player.id);
              return (
                <li key={player.id}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span className="author">{player.name}</span>
                    {isAuthor && <span className="badge badge-you">Tú</span>}
                    {previousWords.length > 0 && (
                      <span style={{ 
                        fontSize: '0.85rem', 
                        color: '#a5b4fc',
                        marginLeft: 'auto',
                        fontStyle: 'italic'
                      }}>
                        {previousWords.join(', ')}
                      </span>
                    )}
                  </div>
                  <span className="word">{clueWord}</span>
                </li>
              );
            })}
          </ul>
        </section>
        {turnPlayer ? (
          isMyTurn ? (
          <section className="turn">
            <p>
              Turno de <strong>{turnPlayer.name}</strong>
            </p>
              {gameState.timeLimit && turnTimeRemaining !== null && !hasGivenClueThisRound(gameState, turnPlayer.id) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div className="turn-timer-bar" style={{ flex: 1 }}>
                    <div 
                      className="turn-timer-progress" 
                      style={{ 
                        width: `${(turnTimeRemaining / gameState.timeLimit) * 100}%`,
                        transition: 'width 1s linear, background 0.5s ease',
                        background: getProgressColor(turnTimeRemaining, gameState.timeLimit)
                      }}
                    />
                  </div>
                  <span style={{ color: '#a78bfa', fontSize: '0.9rem', fontWeight: 600, minWidth: '30px', textAlign: 'right' }}>
                    {turnTimeRemaining}s
                  </span>
                </div>
              )}
              <form className="form-inline" onSubmit={handleClueSubmit}>
                <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                <input
                  autoFocus
                  value={clueInput}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value.length <= 30) {
                      // Si singleWordOnly está activado, solo permitir una palabra
                      if (gameState?.singleWordOnly) {
                        const words = value.trim().split(/\s+/);
                        if (words.length <= 1) {
                          setClueInput(value);
                          clueInputRef.current = value;
                        }
                      } else {
                        setClueInput(value);
                        clueInputRef.current = value;
                      }
                    }
                  }}
                  placeholder="Tu pista"
                  autoComplete="off"
                  data-form-type="other"
                  data-lpignore="true"
                  data-1p-ignore="true"
                    maxLength={30}
                    style={{ paddingRight: '50px' }}
                  />
                  {clueInput.length > 20 && (
                    <span style={{ 
                      position: 'absolute',
                      right: '12px',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      fontSize: '0.75rem', 
                      color: '#9ca3af',
                      pointerEvents: 'none',
                      lineHeight: '1.2'
                    }}>
                      {clueInput.length}/30
                    </span>
                  )}
                </div>
                <button type="submit" className="primary" disabled={!clueInput.trim()}>
                  Enviar
                </button>
              </form>
          </section>
        ) : (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <p style={{ margin: '0 0 8px 0', color: '#e0e7ff', fontSize: '1rem' }}>
                Turno de <strong>{turnPlayer.name}</strong>
              </p>
              <p style={{ margin: 0, color: '#a5b4fc', fontSize: '0.9rem' }}>
                Esperando su respuesta
              </p>
            </div>
          )
        ) : null}
        {revealCountdown !== null && revealCountdown > 0 && (
          <div className="countdown-container">
            <p className="countdown-label">Abriendo votaciones en...</p>
            <div className="countdown-number">{revealCountdown}</div>
          </div>
        )}
      </div>
    );
  };

  const renderVoting = () => {
    if (!gameState || !currentPlayer) return null;

    // Obtener todas las pistas de todas las rondas hasta la actual (incluyendo jugadores muertos para orden cronológico)
    const allClues = gameState.clues.filter(clue => clue.round <= gameState.round);
    
    // Agrupar pistas por jugador y ordenar por ronda (orden cronológico)
    const cluesByPlayer = new Map<string, Array<{ word: string; round: number; createdAt: number }>>();
    allClues.forEach(clue => {
      if (!cluesByPlayer.has(clue.playerId)) {
        cluesByPlayer.set(clue.playerId, []);
      }
      cluesByPlayer.get(clue.playerId)!.push({
        word: clue.word,
        round: clue.round,
        createdAt: clue.createdAt
      });
    });
    
    // Ordenar las pistas de cada jugador por ronda (orden cronológico)
    cluesByPlayer.forEach((clues) => {
      clues.sort((a, b) => a.round - b.round || a.createdAt - b.createdAt);
    });
    
    // Obtener pistas de la ronda actual ordenadas por tiempo de creación (para el orden de votación)
    const cluesOrdered = [...cluesCurrentRound].sort((a, b) => a.createdAt - b.createdAt);
    
    // Crear lista de jugadores con todas sus palabras, ordenados por tiempo de respuesta de la ronda actual
    const playersWithClues = cluesOrdered.map(clue => {
      const player = alivePlayers.find(p => p.id === clue.playerId);
      if (!player) return null;
      
      const allWords = cluesByPlayer.get(player.id) || [];
      const lastWord = allWords[allWords.length - 1]?.word || '-';
      const previousWords = allWords.slice(0, -1); // Todas excepto la última
      
      return { 
        player, 
        clue: lastWord, // Última palabra para compatibilidad
        allWords, // Todas las palabras de todas las rondas
        previousWords, // Palabras anteriores (sin la última)
        createdAt: clue.createdAt 
      };
    }).filter((item): item is { player: typeof alivePlayers[0], clue: string, allWords: Array<{ word: string; round: number; createdAt: number }>, previousWords: Array<{ word: string; round: number; createdAt: number }>, createdAt: number } => item !== null);
    
    // Añadir jugadores que no tienen pista en la ronda actual
    const playersWithoutClues = alivePlayers
      .filter(p => !cluesOrdered.some(clue => clue.playerId === p.id))
      .map(player => {
        const allWords = cluesByPlayer.get(player.id) || [];
        const lastWord = allWords[allWords.length - 1]?.word || '-';
        const previousWords = allWords.slice(0, -1); // Todas excepto la última
        return { 
          player, 
          clue: lastWord,
          allWords,
          previousWords,
          createdAt: Infinity 
        };
      });
    
    // Combinar y ordenar todos los jugadores por orden de respuesta de la ronda actual
    const allPlayersOrdered = [...playersWithClues, ...playersWithoutClues]
      .sort((a, b) => a.createdAt - b.createdAt);

    // Verificar si el jugador actual ha votado (para el botón de confirmación)
    const hasVoted = !!gameState.votes[playerId];

    // Función para obtener quién ha votado a un jugador
    const getVotersForPlayer = (targetPlayerId: string) => {
      return Object.entries(gameState.votes)
        .filter(([, targetId]) => targetId === targetPlayerId)
        .map(([voterId]) => {
          const voter = gameState.players.find(p => p.id === voterId);
          return voter ? voter.name : voterId;
        });
    };

    // Función para obtener el color del progreso (similar a la de pistas)
    const getProgressColor = (remaining: number, total: number) => {
      const percentage = remaining / total;
      if (percentage > 0.5) {
        return 'linear-gradient(90deg, rgba(139, 92, 246, 0.8) 0%, rgba(139, 92, 246, 0.6) 50%, rgba(139, 92, 246, 0.8) 100%)';
      } else {
        const redFactor = 1 - (percentage * 2);
        const r = Math.round(139 + (220 - 139) * redFactor);
        const g = Math.round(92 + (38 - 92) * redFactor);
        const b = Math.round(246 + (38 - 246) * redFactor);
        return `linear-gradient(90deg, rgba(${r}, ${g}, ${b}, 0.8) 0%, rgba(${Math.round(r * 0.7)}, ${Math.round(g * 0.7)}, ${Math.round(b * 0.7)}, 0.8) 50%, rgba(${r}, ${g}, ${b}, 0.8) 100%)`;
      }
    };

    return (
      <div className="card">
        <header className="header">
          <h2>Votación</h2>
          <button type="button" className="close-button" onClick={handleLeaveRoom} aria-label="Cerrar">
            ×
          </button>
        </header>
        {gameState.votingTimeLimit && votingTimeRemaining !== null && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '16px 0 24px 0' }}>
            <div className="turn-timer-bar" style={{ flex: 1 }}>
              <div 
                className="turn-timer-progress" 
                style={{ 
                  width: `${(votingTimeRemaining / gameState.votingTimeLimit) * 100}%`,
                  transition: 'width 1s linear, background 0.5s ease',
                  background: getProgressColor(votingTimeRemaining, gameState.votingTimeLimit)
                }}
              />
            </div>
            <span style={{ color: '#a78bfa', fontSize: '0.9rem', fontWeight: 600, minWidth: '30px', textAlign: 'right' }}>
              {votingTimeRemaining}s
            </span>
          </div>
        )}
        <section className="vote-grid" style={{ marginTop: gameState.votingTimeLimit && votingTimeRemaining !== null ? '0' : '24px' }}>
          {allPlayersOrdered.map(({ player, clue, allWords, previousWords }) => {
            const isCurrentPlayer = player.id === playerId;
            const votesAgainst = Object.values(gameState.votes).filter((voteTarget) => voteTarget === player.id).length;
            const voters = getVotersForPlayer(player.id);
            const isSelected = currentPlayer.vote === player.id;
            const isVoteConfirmed = gameState.confirmedVotes?.includes(playerId) ?? false;
            const isVoteLocked = (!gameState.allowVoteChange && hasVoted && !isSelected) || (isVoteConfirmed && !isSelected);
            
            // Determinar el layout según el modo de visualización (estático, no cambia con votos)
            const showVoteCount = gameState.voteDisplayMode !== 'hidden';
            const showVoters = gameState.voteDisplayMode === 'visible';
            
            // Layout estático: 'visible' y 'count' usan grid 2x2, 'hidden' usa flex horizontal
            const useGridLayout = showVoteCount;
            
            return (
              <button
                type="button"
                key={player.id}
                className={`vote-card${isSelected ? ' selected' : ''}${isCurrentPlayer ? ' disabled' : ''}${isVoteLocked ? ' locked' : ''}`}
                onClick={() => !isCurrentPlayer && !isVoteLocked && handleVote(player.id)}
                disabled={isCurrentPlayer || isVoteLocked}
                style={{
                  display: useGridLayout ? 'grid' : 'flex',
                  gridTemplateColumns: useGridLayout ? '1fr 1fr' : undefined,
                  gridTemplateRows: useGridLayout ? 'auto auto' : undefined,
                  flexDirection: useGridLayout ? undefined : 'row',
                  alignItems: useGridLayout ? 'start' : 'center',
                  justifyContent: useGridLayout ? 'stretch' : 'center',
                  gap: useGridLayout ? '8px 12px' : '16px',
                  padding: '12px 16px',
                  textAlign: useGridLayout ? 'left' : 'center',
                  alignContent: useGridLayout ? 'stretch' : undefined
                }}
              >
                {/* Nombre del jugador */}
                <div style={{ 
                  fontSize: '1.05rem', 
                  fontWeight: 600, 
                  color: '#e0e7ff',
                  gridColumn: useGridLayout ? '1' : undefined,
                  gridRow: useGridLayout ? '1' : undefined
                }}>
                  {player.name}
                </div>
                
                {/* Recuento de votos con número grande */}
                {showVoteCount && (
                  <div style={{ 
                    gridColumn: useGridLayout ? '2' : undefined,
                    gridRow: useGridLayout ? '1' : undefined,
                    textAlign: 'right',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-end',
                    justifyContent: 'center',
                    gap: '2px'
                  }}>
                    <div style={{ 
                      fontSize: '2rem', 
                      color: '#a78bfa', 
                      fontWeight: 700,
                      lineHeight: '1'
                    }}>
                      {votesAgainst}
                    </div>
                  </div>
                )}
                
                {/* Palabra/Respuesta - Mostrar "Anteriores:" y "Última:" en una sola línea */}
                <div style={{ 
                  fontSize: '0.9rem', 
                  color: '#a5b4fc',
                  gridColumn: useGridLayout ? '1' : undefined,
                  gridRow: useGridLayout ? '2' : undefined,
                  textAlign: useGridLayout ? 'left' : 'center',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px'
                }}>
                  {(() => {
                    const prevWords = previousWords || [];
                    const lastWordData = allWords && allWords.length > 0 ? allWords[allWords.length - 1] : null;
                    const lastWord = lastWordData?.word || clue;
                    
                    // Si es la primera ronda (no hay palabras anteriores), mostrar solo la palabra
                    if (prevWords.length === 0) {
                      return <span>{lastWord}</span>;
                    }
                    
                    // Si hay palabras anteriores, mostrar "Anteriores:" y "Última:" en líneas separadas pero cada una en una sola línea
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {prevWords.length > 0 && (
                          <div style={{ 
                            display: 'flex', 
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: '6px',
                            flexWrap: 'wrap'
                          }}>
                            <span style={{ 
                              fontSize: '0.75rem', 
                              color: '#6b7280',
                              fontWeight: 500,
                              whiteSpace: 'nowrap'
                            }}>
                              Anteriores:
                            </span>
                            <span style={{ 
                              fontSize: '0.85rem', 
                              color: '#a5b4fc',
                              fontWeight: 400
                            }}>
                              {prevWords.map((w: { word: string }) => w.word).join(', ')}
                            </span>
                          </div>
                        )}
                        <div style={{ 
                          display: 'flex', 
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: '6px',
                          flexWrap: 'wrap'
                        }}>
                          <span style={{ 
                            fontSize: '0.75rem', 
                            color: '#a78bfa',
                            fontWeight: 600,
                            whiteSpace: 'nowrap'
                          }}>
                            Última:
                          </span>
                          <span style={{ 
                            fontSize: '1rem', 
                            color: '#e0e7ff',
                            fontWeight: 700
                          }}>
                            {lastWord}
                          </span>
                        </div>
                      </div>
                    );
                  })()}
                </div>
                
                {/* Votantes (siempre en la fila 2, columna 2) */}
                {showVoters && (
                  <div style={{ 
                    gridColumn: useGridLayout ? '2' : undefined,
                    gridRow: useGridLayout ? '2' : undefined,
                    textAlign: useGridLayout ? 'right' : 'center',
                    fontSize: '0.7rem', 
                    color: '#9ca3af', 
                    lineHeight: '1.2',
                    maxWidth: '120px',
                    wordBreak: 'break-word',
                    marginLeft: useGridLayout ? 'auto' : undefined
                  }}>
                    {voters.length > 0 ? voters.join(', ') : 'Sin votos'}
                  </div>
                )}
              </button>
            );
          })}
        </section>
        {gameState.allowVoteChange && (
          <div style={{ marginTop: '24px', display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'center' }}>
            <button
              type="button"
              className="button primary"
              onClick={handleConfirmVote}
              disabled={!hasVoted || (gameState.confirmedVotes?.includes(playerId) ?? false)}
              style={{
                opacity: (!hasVoted || (gameState.confirmedVotes?.includes(playerId) ?? false)) ? 0.5 : 1,
                cursor: (!hasVoted || (gameState.confirmedVotes?.includes(playerId) ?? false)) ? 'not-allowed' : 'pointer'
              }}
            >
              {gameState.confirmedVotes?.includes(playerId) ? 'Voto confirmado' : 'Confirmar voto'}
          </button>
            <div style={{ fontSize: '0.9rem', color: '#a5b4fc', textAlign: 'center' }}>
              {gameState.confirmedVotes?.length ?? 0} votación{gameState.confirmedVotes?.length !== 1 ? 'es' : ''} confirmada{(gameState.confirmedVotes?.length ?? 0) !== 1 ? 's' : ''}
            </div>
            </div>
          )}
      </div>
    );
  };

  const renderTiebreaker = () => {
    if (!gameState || !currentPlayer || !gameState.tiebreaker) return null;

    const { tiedPlayers, voteCount, previousVotes } = gameState.tiebreaker;
    const isTiedPlayer = tiedPlayers.includes(playerId);
    
    // Obtener nombres de los jugadores empatados
    const tiedPlayerNames = tiedPlayers
      .map(id => gameState.players.find(p => p.id === id)?.name)
      .filter(Boolean) as string[];
    
    // Crear mensaje de empate
    const tieMessage = tiedPlayerNames.length === 2
      ? `${tiedPlayerNames[0]} y ${tiedPlayerNames[1]} han empatado con ${voteCount} ${voteCount === 1 ? 'voto' : 'votos'}`
      : tiedPlayerNames.length === 3
      ? `${tiedPlayerNames[0]}, ${tiedPlayerNames[1]} y ${tiedPlayerNames[2]} han empatado con ${voteCount} ${voteCount === 1 ? 'voto' : 'votos'}`
      : `${tiedPlayerNames.join(', ')} han empatado con ${voteCount} ${voteCount === 1 ? 'voto' : 'votos'}`;

    // Obtener jugadores empatados vivos
    const tiedPlayersAlive = alivePlayers.filter(p => tiedPlayers.includes(p.id));
    
    // Obtener pistas de la ronda actual ordenadas por tiempo
    const cluesOrdered = [...cluesCurrentRound].sort((a, b) => a.createdAt - b.createdAt);
    const cluesMap = new Map(cluesOrdered.map(clue => [clue.playerId, clue]));

    // Función para obtener quién ha votado a un jugador (usar previousVotes para el contador inicial)
    const getVotersForPlayer = (targetPlayerId: string, usePrevious: boolean = false) => {
      const votesToUse = usePrevious ? previousVotes : gameState.votes;
      return Object.entries(votesToUse)
        .filter(([, targetId]) => targetId === targetPlayerId)
        .map(([voterId]) => {
          const voter = gameState.players.find(p => p.id === voterId);
          return voter ? voter.name : voterId;
        });
    };

    // Función para obtener el color del progreso
    const getProgressColor = (remaining: number, total: number) => {
      const percentage = remaining / total;
      if (percentage > 0.5) {
        return 'linear-gradient(90deg, rgba(139, 92, 246, 0.8) 0%, rgba(139, 92, 246, 0.6) 50%, rgba(139, 92, 246, 0.8) 100%)';
      } else {
        const redFactor = 1 - (percentage * 2);
        const r = Math.round(139 + (220 - 139) * redFactor);
        const g = Math.round(92 + (38 - 92) * redFactor);
        const b = Math.round(246 + (38 - 246) * redFactor);
        return `linear-gradient(90deg, rgba(${r}, ${g}, ${b}, 0.8) 0%, rgba(${Math.round(r * 0.7)}, ${Math.round(g * 0.7)}, ${Math.round(b * 0.7)}, 0.8) 50%, rgba(${r}, ${g}, ${b}, 0.8) 100%)`;
      }
    };

    const hasVoted = !!gameState.votes[playerId];
    const previousVote = previousVotes[playerId];
    const showVoteCount = gameState.voteDisplayMode !== 'hidden';
    const showVoters = gameState.voteDisplayMode === 'visible';
    
    // El voto actual es el que está en el estado (que se establece automáticamente al entrar en tiebreaker)
    // o el que el jugador ha seleccionado manualmente
    const currentVote = gameState.votes[playerId] || currentPlayer.vote;
    const isVoteConfirmed = gameState.confirmedVotes?.includes(playerId) ?? false;
    const canInteract = !isTiedPlayer;

    return (
      <div className="card">
        <header className="header">
          <h2>Desempate</h2>
        </header>
        
        {/* Mensaje de empate */}
        <section style={{ textAlign: 'center', padding: '16px 0', borderBottom: '1px solid rgba(139, 92, 246, 0.2)' }}>
          <p style={{ fontSize: '1.1rem', color: '#e0e7ff', fontWeight: 600 }}>
            {tieMessage}
          </p>
          {isTiedPlayer && (
            <p style={{ fontSize: '0.95rem', color: '#a5b4fc', marginTop: '8px' }}>
              Estás empatado. Los demás jugadores votarán para decidir.
            </p>
          )}
        </section>

        {/* Contador de 10 segundos */}
        {tiebreakerTimeRemaining !== null && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '16px 0 24px 0' }}>
            <div className="turn-timer-bar" style={{ flex: 1 }}>
              <div 
                className="turn-timer-progress" 
                style={{ 
                  width: `${(tiebreakerTimeRemaining / 10) * 100}%`,
                  transition: 'width 1s linear, background 0.5s ease',
                  background: getProgressColor(tiebreakerTimeRemaining, 10)
                }}
              />
            </div>
            <span style={{ color: '#a78bfa', fontSize: '0.9rem', fontWeight: 600, minWidth: '30px', textAlign: 'right' }}>
              {tiebreakerTimeRemaining}s
            </span>
          </div>
        )}

        {/* Opciones de voto - Mostrar directamente los botones */}
        <section className="vote-grid">
          {tiedPlayersAlive.map((player) => {
            const clue = cluesMap.get(player.id)?.word || '-';
            const isSelected = currentVote === player.id;
            // Mostrar el contador basado en previousVotes (votos de la votación anterior) si no hay votos nuevos aún
            // Si hay votos nuevos, mostrar esos; si no, mostrar los previos
            const hasNewVotes = Object.keys(gameState.votes).length > 0;
            const votesAgainst = hasNewVotes 
              ? Object.values(gameState.votes).filter((voteTarget) => voteTarget === player.id).length
              : Object.values(previousVotes).filter((voteTarget) => voteTarget === player.id).length;
            const voters = getVotersForPlayer(player.id, !hasNewVotes);
            const canChangeVote = gameState.allowVoteChange || !hasVoted;
            const isVoteLocked = (!canChangeVote && hasVoted && !isSelected) || (isVoteConfirmed && !isSelected);
            const isDisabled = !canInteract || isVoteLocked;
            
            const useGridLayout = showVoteCount;
            
            return (
              <button
                type="button"
                key={player.id}
                className={`vote-card${isSelected ? ' selected' : ''}${isVoteLocked ? ' locked' : ''}${!canInteract ? ' disabled' : ''}`}
                onClick={() => canInteract && !isVoteLocked && handleVote(player.id)}
                disabled={isDisabled}
                style={{
                  display: useGridLayout ? 'grid' : 'flex',
                  gridTemplateColumns: useGridLayout ? '1fr 1fr' : undefined,
                  gridTemplateRows: useGridLayout ? 'auto auto' : undefined,
                  flexDirection: useGridLayout ? undefined : 'row',
                  alignItems: useGridLayout ? 'start' : 'center',
                  justifyContent: useGridLayout ? 'stretch' : 'center',
                  gap: useGridLayout ? '8px 12px' : '16px',
                  padding: '12px 16px',
                  textAlign: useGridLayout ? 'left' : 'center',
                  alignContent: useGridLayout ? 'stretch' : undefined,
                  border: previousVote === player.id ? '2px solid #a78bfa' : undefined,
                  opacity: !canInteract ? 0.6 : 1,
                  cursor: isDisabled ? 'not-allowed' : 'pointer'
                }}
              >
                <div style={{ 
                  fontSize: '1.05rem', 
                  fontWeight: 600, 
                  color: '#e0e7ff',
                  gridColumn: useGridLayout ? '1' : undefined,
                  gridRow: useGridLayout ? '1' : undefined
                }}>
                  {player.name}
                  {previousVote === player.id && (
                    <span style={{ marginLeft: '6px', fontSize: '0.85rem', color: '#a78bfa' }}>
                      (anterior)
                    </span>
                  )}
                </div>
                
                {showVoteCount && (
                  <div style={{ 
                    gridColumn: useGridLayout ? '2' : undefined,
                    gridRow: useGridLayout ? '1' : undefined,
                    textAlign: 'right',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-end',
                    justifyContent: 'center',
                    gap: '2px'
                  }}>
                    <div style={{ 
                      fontSize: '2rem', 
                      color: '#a78bfa', 
                      fontWeight: 700,
                      lineHeight: '1'
                    }}>
                      {votesAgainst}
                    </div>
                    {showVoters && voters.length > 0 && (
                      <div style={{ 
                        fontSize: '0.75rem', 
                        color: '#c4b5fd',
                        textAlign: 'right',
                        maxWidth: '100px'
                      }}>
                        {voters.join(', ')}
                      </div>
                    )}
                  </div>
                )}
                
                {/* Mostrar la palabra/pista del jugador */}
                <div style={{ 
                  gridColumn: useGridLayout ? '1 / -1' : undefined,
                  gridRow: useGridLayout ? '2' : undefined,
                  fontSize: '0.9rem',
                  color: '#a5b4fc',
                  marginTop: useGridLayout ? '4px' : '8px',
                  textAlign: useGridLayout ? 'left' : 'center'
                }}>
                  {clue}
                </div>
              </button>
            );
          })}
        </section>

        {/* Botón de confirmar voto - Mostrar desde el principio si allowVoteChange está activado */}
        {gameState.allowVoteChange && canInteract && (
          <footer className="footer" style={{ marginTop: '24px' }}>
            <button 
              type="button" 
              className="button primary" 
              onClick={handleConfirmVote}
              disabled={!hasVoted || isVoteConfirmed}
              style={{
                opacity: (!hasVoted || isVoteConfirmed) ? 0.5 : 1,
                cursor: (!hasVoted || isVoteConfirmed) ? 'not-allowed' : 'pointer'
              }}
            >
              {isVoteConfirmed ? 'Voto confirmado' : 'Confirmar voto'}
              </button>
            <div style={{ fontSize: '0.9rem', color: '#a5b4fc', textAlign: 'center', marginTop: '12px' }}>
              {gameState.confirmedVotes?.length ?? 0} votación{gameState.confirmedVotes?.length !== 1 ? 'es' : ''} confirmada{(gameState.confirmedVotes?.length ?? 0) !== 1 ? 's' : ''}
            </div>
        </footer>
        )}
      </div>
    );
  };

  const renderReveal = () => {
    if (!gameState) return null;
    
    // Si hay eliminación, mostrar resultado con animación
    if (gameState.elimination) {
    const eliminated = gameState.players.find((player) => player.id === gameState.elimination?.targetId);
      const gameEnded = gameState.winner !== undefined;
      const eliminatedName = eliminated?.name ?? 'Jugador desconocido';
      
      // Texto que se animará (solo la parte "era el impostor" o "era inocente")
      const fullText = gameState.elimination.wasImpostor 
        ? 'era el impostor'
        : 'era inocente';
      
      // Texto visible según el progreso de la animación
      const visibleText = fullText.slice(0, revealTextProgress);
      
      // Determinar qué mostrar en la pantalla de resultado
      const nextRound = gameState.round + 1;
      const impostorPlayer = gameState.players.find(p => p.isImpostor);
      const civilianPlayers = gameState.players.filter(p => !p.isImpostor);

    return (
        <>
          {/* Pantalla principal de revelación */}
          <div 
            className={`card reveal-animation-container ${showResultScreen ? 'blur-out' : ''}`}
            style={{
              transition: showResultScreen ? 'filter 0.8s ease-out, opacity 0.8s ease-out' : 'none',
              filter: showResultScreen ? 'blur(15px)' : 'blur(0px)',
              opacity: showResultScreen ? 0.3 : 1,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'center',
              minHeight: '100vh',
              maxHeight: '100vh',
              padding: '40px 20px',
              overflow: 'hidden',
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              width: '100%'
            }}
          >
            <section className="reveal-result" style={{ 
              display: 'flex', 
              flexDirection: 'column', 
              justifyContent: 'center', 
              alignItems: 'center',
              textAlign: 'center',
              width: '100%'
            }}>
              {/* Nombre del jugador eliminado - aparece inmediatamente */}
              <h2 className="eliminated-name" style={{ 
                fontSize: '32px', 
                fontWeight: 700, 
                marginBottom: '32px',
                color: '#ffffff',
                textAlign: 'center',
                width: '100%'
              }}>
                {eliminatedName}
              </h2>
              
              {/* Texto animado - aparece letra por letra */}
              <p className="reveal-text-animated" style={{ 
                fontSize: '24px', 
                fontWeight: 600,
                minHeight: '40px',
                textAlign: 'center',
                color: '#ffffff', // Color fijo blanco para ambos casos
                fontFamily: '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif', // Fuente más redondeada
                width: '100%'
              }}>
                {visibleText}
              </p>
            </section>
          </div>

          {/* Pantalla de resultado con blur entrante */}
          {showResultScreen && (
            <div className="result-screen-overlay" style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(10, 14, 39, 0.95)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'center',
              zIndex: 1000,
              padding: '20px',
              animation: 'fadeInBlur 0.5s ease-in'
            }}>
              <div className="result-content" style={{
                textAlign: 'center',
                animation: 'slideInUp 0.6s ease-out'
              }}>
                {!gameEnded ? (
                  // La partida continúa - mostrar siguiente ronda
                  <>
                    <h2 style={{ 
                      fontSize: '36px', 
                      fontWeight: 700, 
                      color: '#ffffff',
                      marginBottom: '24px'
                    }}>
                      Ronda {nextRound}
                    </h2>
                    <p style={{ 
                      color: '#a5b4fc', 
                      fontSize: '16px',
                      marginTop: '16px'
                    }}>
                      La partida continúa...
                    </p>
                  </>
                ) : gameState.winner === 'impostor' ? (
                  // El impostor ganó
                  <>
                    <h2 style={{ 
                      fontSize: '36px', 
                      fontWeight: 700, 
                      color: '#ef4444',
                      marginBottom: '24px'
                    }}>
                      Ganador
                    </h2>
                    {impostorPlayer && (
                      <p style={{ 
                        fontSize: '28px', 
                        fontWeight: 600,
                        color: '#ffffff',
                        marginTop: '16px'
                      }}>
                        {impostorPlayer.name}
            </p>
          )}
                  </>
                ) : (
                  // Los civiles ganaron
                  <>
                    <h2 style={{ 
                      fontSize: '36px', 
                      fontWeight: 700, 
                      color: '#10b981',
                      marginBottom: '24px'
                    }}>
                      Ganadores
                    </h2>
                    <div style={{ marginTop: '16px' }}>
                      {civilianPlayers.map((player, index) => (
                        <p key={player.id} style={{ 
                          fontSize: '24px', 
                          fontWeight: 600,
                          color: '#ffffff',
                          marginBottom: index < civilianPlayers.length - 1 ? '12px' : '0'
                        }}>
                          {player.name}
                        </p>
                      ))}
                    </div>
                  </>
                )}

                {/* Mensaje de espera y botón */}
                {gameEnded && (
                  <div style={{ marginTop: '40px' }}>
                    {!isHost && (
                      <p style={{ 
                        color: '#a5b4fc', 
                        fontSize: '16px',
                        animation: 'fadeIn 0.8s ease-in 0.3s both'
                      }}>
                        Esperando al anfitrión...
                      </p>
                    )}
                    {isHost && (
                      <button 
                        type="button" 
                        className="button primary" 
                        onClick={handleContinueAfterReveal}
                        style={{
                          marginTop: '24px',
                          animation: 'fadeIn 0.8s ease-in 0.3s both'
                        }}
                      >
                        Nueva partida
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      );
    }
    
    // Si no hay eliminación (empate), mostrar la misma pantalla de eliminación pero con "Empate" y "No se ha eliminado a nadie"
    const gameEnded = gameState.winner !== undefined;
    const eliminatedName = 'Empate';
    
    // Texto que se animará
    const fullText = 'No se ha eliminado a nadie';
    
    // Texto visible según el progreso de la animación
    const visibleText = fullText.slice(0, revealTextProgress);
    
    // Determinar qué mostrar en la pantalla de resultado
    const nextRound = gameState.round + 1;
    const impostorPlayer = gameState.players.find(p => p.isImpostor);
    const civilianPlayers = gameState.players.filter(p => !p.isImpostor);

    return (
      <>
        {/* Pantalla principal de revelación */}
        <div 
          className={`card reveal-animation-container ${showResultScreen ? 'blur-out' : ''}`}
          style={{
            transition: showResultScreen ? 'filter 0.8s ease-out, opacity 0.8s ease-out' : 'none',
            filter: showResultScreen ? 'blur(15px)' : 'blur(0px)',
            opacity: showResultScreen ? 0.3 : 1,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            minHeight: '100vh',
            maxHeight: '100vh',
            padding: '40px 20px',
            overflow: 'hidden',
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            width: '100%'
          }}
        >
          <section className="reveal-result" style={{ 
            display: 'flex', 
            flexDirection: 'column', 
            justifyContent: 'center', 
            alignItems: 'center',
            textAlign: 'center',
            width: '100%'
          }}>
            {/* Nombre - "Empate" aparece inmediatamente */}
            <h2 className="eliminated-name" style={{ 
              fontSize: '32px', 
              fontWeight: 700, 
              marginBottom: '32px',
              color: '#ffffff',
              textAlign: 'center',
              width: '100%'
            }}>
              {eliminatedName}
            </h2>
            
            {/* Texto animado - aparece letra por letra */}
            <p className="reveal-text-animated" style={{ 
              fontSize: '24px', 
              fontWeight: 600,
              minHeight: '40px',
              textAlign: 'center',
              color: '#ffffff',
              fontFamily: '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif',
              width: '100%'
            }}>
              {visibleText}
            </p>
        </section>
        </div>

        {/* Pantalla de resultado con blur entrante */}
        {showResultScreen && (
          <div className="result-screen-overlay" style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(10, 14, 39, 0.95)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 1000,
            padding: '20px',
            animation: 'fadeInBlur 0.5s ease-in'
          }}>
            <div className="result-content" style={{
              textAlign: 'center',
              animation: 'slideInUp 0.6s ease-out'
            }}>
              {!gameEnded ? (
                // La partida continúa - mostrar siguiente ronda
                <>
                  <h2 style={{ 
                    fontSize: '36px', 
                    fontWeight: 700, 
                    color: '#ffffff',
                    marginBottom: '24px'
                  }}>
                    Ronda {nextRound}
                  </h2>
                  <p style={{ 
                    color: '#a5b4fc', 
                    fontSize: '16px',
                    marginTop: '16px'
                  }}>
                    La partida continúa...
                  </p>
                </>
              ) : gameState.winner === 'impostor' ? (
                // El impostor ganó
                <>
                  <h2 style={{ 
                    fontSize: '36px', 
                    fontWeight: 700, 
                    color: '#ef4444',
                    marginBottom: '24px'
                  }}>
                    Ganador
                  </h2>
                  {impostorPlayer && (
                    <p style={{ 
                      fontSize: '28px', 
                      fontWeight: 600,
                      color: '#ffffff',
                      marginTop: '16px'
                    }}>
                      {impostorPlayer.name}
                    </p>
                  )}
                </>
              ) : (
                // Los civiles ganaron
                <>
                  <h2 style={{ 
                    fontSize: '36px', 
                    fontWeight: 700, 
                    color: '#10b981',
                    marginBottom: '24px'
                  }}>
                    Ganadores
                  </h2>
                  <div style={{ marginTop: '16px' }}>
                    {civilianPlayers.map((player, index) => (
                      <p key={player.id} style={{ 
                        fontSize: '24px', 
                        fontWeight: 600,
                        color: '#ffffff',
                        marginBottom: index < civilianPlayers.length - 1 ? '12px' : '0'
                      }}>
                        {player.name}
                      </p>
                    ))}
                  </div>
                </>
              )}

              {gameEnded && (
                <div style={{ marginTop: '40px' }}>
                  {!isHost && (
                    <p style={{
                      color: '#a5b4fc',
                      fontSize: '16px',
                      animation: 'fadeIn 0.8s ease-in 0.3s both'
                    }}>
                      Esperando al anfitrión...
                    </p>
                  )}
        {isHost && (
                    <button
                      type="button"
                      className="button primary"
                      onClick={handleContinueAfterReveal}
                      style={{
                        marginTop: '24px',
                        animation: 'fadeIn 0.8s ease-in 0.3s both'
                      }}
                    >
                      Nueva partida
            </button>
        )}
      </div>
              )}
            </div>
          </div>
        )}
      </>
    );
  };


  // Modo demo local (sin configuración necesaria)
  const isDemoMode = !database;
  
  if (isDemoMode && roomCode) {
    // En modo demo, solo permitir un jugador (el host)
    if (!isHost) {
      return (
        <main className="app">
          <div className="card">
            <h2>Modo Demo</h2>
            <p>En modo demo solo puedes jugar como anfitrión. Para jugar con otros jugadores, configura Firebase o Supabase.</p>
            <button type="button" className="primary" onClick={resetSession}>
              Volver al inicio
            </button>
          </div>
        </main>
      );
    }
  }

  const phase = gameState?.phase ?? (roomCode ? 'lobby' : 'home');

  // Mostrar contenido de carga mientras se monta
  if (!isMounted) {
    return (
      <main className="app">
        <div className="card">
          <h2>Cargando...</h2>
          <p className="waiting">Inicializando aplicación...</p>
        </div>
      </main>
    );
  }

  try {
  return (
    <main className="app">
      {/* Modo local (un solo dispositivo) */}
      {isLocalMode && !roomCode ? (
        <>
          {localPhase === 'players' && renderLocalPlayers()}
          {localPhase === 'config' && renderLocalConfig()}
          {localPhase === 'reveal' && renderLocalReveal()}
          {localPhase === 'game' && renderLocalGame()}
        </>
      ) : !roomCode ? renderHome() : null}
      {roomCode && (!gameState || phase === 'lobby') ? renderLobby() : null}
      {roomCode && gameState && phase === 'wordReveal' ? renderWordReveal() : null}
      {roomCode && gameState && phase === 'clue' ? renderCluePhase() : null}
      {roomCode && gameState && phase === 'voting' ? renderVoting() : null}
        {roomCode && gameState && phase === 'tiebreaker' ? renderTiebreaker() : null}
      {roomCode && gameState && phase === 'reveal' ? renderReveal() : null}
      {statusMessage && <div className="status">{statusMessage}</div>}
      
      {/* Overlay para jugadores eliminados - Solo mostrar después de la revelación y si la partida continúa */}
      {roomCode && gameState && currentPlayer && !currentPlayer.alive && 
       gameState.phase !== 'reveal' && gameState.winner === undefined && (
        <>
          {/* Borde rojo alrededor de toda la pantalla */}
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            border: '4px solid rgba(239, 68, 68, 0.6)',
            zIndex: 9998,
            pointerEvents: 'none',
            boxShadow: 'inset 0 0 0 4px rgba(239, 68, 68, 0.3)',
          }} />
          
          {/* Mensaje en esquina superior izquierda */}
          <div style={{
            position: 'fixed',
            top: '16px',
            left: '16px',
            zIndex: 9999,
            pointerEvents: 'none',
          }}>
            <div style={{
              backgroundColor: 'rgba(239, 68, 68, 0.2)',
              border: '2px solid rgba(239, 68, 68, 0.6)',
              borderRadius: '8px',
              padding: '12px 20px',
              textAlign: 'center',
              backdropFilter: 'blur(2px)',
              WebkitBackdropFilter: 'blur(2px)',
              boxShadow: '0 4px 12px rgba(239, 68, 68, 0.3)',
            }}>
              <h3 style={{
                fontSize: '18px',
                fontWeight: 700,
                color: '#ef4444',
                margin: 0,
                textShadow: '0 1px 2px rgba(0, 0, 0, 0.3)',
              }}>
                ELIMINADO
              </h3>
            </div>
          </div>
        </>
      )}
    </main>
  );
  } catch (error) {
    console.error('Error al renderizar App:', error);
    return (
      <main className="app">
        <div className="card">
          <h2 style={{ color: '#ef4444', marginBottom: '16px' }}>Error al cargar la aplicación</h2>
          <p style={{ color: '#e0e7ff', marginBottom: '12px' }}>
            Ha ocurrido un error. Por favor, recarga la página.
          </p>
          <pre style={{
            background: 'rgba(239, 68, 68, 0.1)',
            padding: '12px',
            borderRadius: '8px',
            fontSize: '12px',
            color: '#fca5a5',
            overflow: 'auto',
            textAlign: 'left'
          }}>
            {error instanceof Error ? error.message : String(error)}
            {error instanceof Error && error.stack ? `\n\n${error.stack}` : ''}
          </pre>
        </div>
      </main>
    );
  }
};

const finishElimination = (state: GameState, targetId: string, playersSnapshot: PlayerState[]): GameState => {
  const updatedPlayers = playersSnapshot.map((player) =>
    player.id === targetId
      ? {
          ...player,
          alive: false,
        }
      : player,
  );
  const eliminatedPlayer = updatedPlayers.find((player) => player.id === targetId);
  const impostorAlive = updatedPlayers.some((player) => player.isImpostor && player.alive);
  const aliveCount = updatedPlayers.filter((player) => player.alive).length;

  // Si no se encuentra el jugador eliminado, pasar a reveal de todas formas (caso de seguridad)
  if (!eliminatedPlayer) {
    return {
      ...state,
      phase: 'reveal',
      votes: {},
      confirmedVotes: [],
      elimination: undefined,
      currentTurnIndex: -1,
    };
  }

  const impostorWin = impostorAlive && aliveCount <= 2;
  const civiliansWin = !impostorAlive;

  let winner: GameState['winner'] = undefined;

  // Determinar el ganador, pero siempre pasar a fase 'reveal' primero
  if (impostorWin) {
    winner = 'impostor';
  } else if (civiliansWin) {
    winner = 'civilians';
  }

  return {
    ...state,
    players: updatedPlayers,
    phase: 'reveal', // Siempre pasar a reveal primero, incluso si el juego terminó
    votes: {},
    confirmedVotes: [],
    elimination: {
      targetId,
      wasImpostor: !!eliminatedPlayer.isImpostor,
    },
    winner,
    currentTurnIndex: -1,
  };
};

export default App;

