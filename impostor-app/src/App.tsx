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
    return { targetId: null, tie: false } as const;
  }

  entries.sort(([, a], [, b]) => b - a);
  const [topTargetId, topVotes] = entries[0];
  const isTie = entries.length > 1 && entries[1][1] === topVotes;
  return { targetId: isTie ? null : topTargetId, tie: isTie } as const;
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
  const [showClueOption, setShowClueOption] = useState<boolean>(false);
  const [allowVoteChangeOption, setAllowVoteChangeOption] = useState<boolean>(true);
  const [singleWordOnlyOption, setSingleWordOnlyOption] = useState<boolean>(false);
  const [showVoteCountOption, setShowVoteCountOption] = useState<boolean>(true);
  const [selectedTimeLimit, setSelectedTimeLimit] = useState<number | undefined>(undefined);
  const [selectedVotingTimeLimit, setSelectedVotingTimeLimit] = useState<number | undefined>(undefined);
  const [activeTimeTab, setActiveTimeTab] = useState<'turno' | 'votaciones' | null>(null);
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [clueInput, setClueInput] = useState('');
  const [countdown, setCountdown] = useState<number | null>(null);
  const [turnTimeRemaining, setTurnTimeRemaining] = useState<number | null>(null);
  const [votingTimeRemaining, setVotingTimeRemaining] = useState<number | null>(null);

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
  const allVotersSubmitted = gameState
    ? alivePlayers.every((player) => !!gameState.votes[player.id]) && alivePlayers.length > 0
    : false;

  useEffect(() => {
    setClueInput('');
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
    setShowClueOption(false);
    setAllowVoteChangeOption(true);
    setSingleWordOnlyOption(false);
    setShowVoteCountOption(true);
    setSelectedTimeLimit(undefined);
    setSelectedVotingTimeLimit(undefined);
    setActiveTimeTab(null);
    setJoinCodeInput('');
    setClueInput('');
  }, []);

  // Función para normalizar el estado de Firebase (asegurar que todos los campos requeridos existan)
  const normalizeState = useCallback((state: any): GameState | null => {
    if (!state) return null;
    
    // Normalizar jugadores y asegurar que isImpostor coincida con impostorId
    const players = Array.isArray(state.players) ? state.players : [];
    const impostorId = state.impostorId;
    
    // Sincronizar isImpostor con impostorId para garantizar consistencia
    const normalizedPlayers = players.map((player: any) => ({
      ...player,
      isImpostor: impostorId ? player.id === impostorId : false,
    }));
    
    return {
      code: state.code || '',
      topic: state.topic || '',
      secretWord: state.secretWord || '',
      selectedPlayer: state.selectedPlayer,
      selectedPlayerClue: state.selectedPlayerClue,
      showClue: state.showClue ?? false,
      allowVoteChange: state.allowVoteChange ?? true,
      singleWordOnly: state.singleWordOnly ?? false,
      showVoteCount: state.showVoteCount ?? true,
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
    [isHost, roomCode],
  );

  // Temporizador para el turno actual
  useEffect(() => {
    if (!gameState || gameState.phase !== 'clue' || !gameState.timeLimit) {
      setTurnTimeRemaining(null);
      return;
    }

    const turnPlayer = gameState.currentTurnIndex >= 0 ? gameState.players[gameState.currentTurnIndex] : null;
    if (!turnPlayer) {
      setTurnTimeRemaining(null);
      return;
    }

    // Verificar si este jugador ya ha dado su pista
    const hasGivenClue = hasGivenClueThisRound(gameState, turnPlayer.id);
    if (hasGivenClue) {
      setTurnTimeRemaining(null);
      return;
    }

    // Iniciar temporizador desde el timeLimit
    setTurnTimeRemaining(gameState.timeLimit);

    const interval = setInterval(() => {
      setTurnTimeRemaining((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(interval);
          // Si es el host y el tiempo se acabó, avanzar automáticamente
          if (isHost && prev !== null && prev <= 1) {
            patchState((prevState) => {
              if (prevState.phase !== 'clue') return prevState;
              const speakerIndex = prevState.currentTurnIndex;
              if (speakerIndex < 0) return prevState;
              const activePlayer = prevState.players[speakerIndex];
              if (!activePlayer || !activePlayer.alive) return prevState;

              // Verificar si ya tiene pista
              const alreadySpoke = hasGivenClueThisRound(prevState, activePlayer.id);
              if (alreadySpoke) return prevState;

              // Añadir pista especial "[SIN RESPUESTA]"
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
      return () => undefined;
    }

    const stateRef = ref(database, `rooms/${roomCode}/state`);
    roomStateRef.current = stateRef;

    const unsubscribe = onValue(stateRef, (snapshot) => {
      const rawState = snapshot.val();
      
      // Si el estado es null y no somos el host, significa que el host cerró la sala
      if (!rawState && !isHost && roomCode) {
        setStatusMessage('El anfitrión ha finalizado la sesión');
        setTimeout(() => {
          resetSession();
        }, 2000);
        return;
      }
      
      const newState = normalizeState(rawState);
      
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
            setChannelReady(true);
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
          setChannelReady(true);
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
        
        // Ignorar nuestros propios eventos EXCEPTO READY_FOR_ROUND, SUBMIT_CLUE y SUBMIT_VOTE (el host necesita procesar estos)
        if (eventData.playerId === playerId && eventData.type !== 'JOIN_REQUEST' && eventData.type !== 'READY_FOR_ROUND' && eventData.type !== 'SUBMIT_CLUE' && eventData.type !== 'SUBMIT_VOTE') {
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
              if (prev.phase !== 'voting') return prev;
              const voter = prev.players.find((player) => player.id === voterId && player.alive);
              const target = prev.players.find((player) => player.id === targetId && player.alive);
              if (!voter || !target) return prev;
              
              // No permitir votar a uno mismo
              if (voterId === targetId) return prev;

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
              const everyoneVoted = Object.keys(updatedVotes).length >= aliveCount;

              if (!everyoneVoted) {
                return {
                  ...prev,
                  votes: updatedVotes,
                  players: updatedPlayers,
                };
              }

              const { targetId: eliminatedId, tie } = resolveVotes({ ...prev, votes: updatedVotes });

              if (tie || !eliminatedId) {
                return {
                  ...prev,
                  votes: updatedVotes,
                  players: updatedPlayers,
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
              if (prev.phase !== 'voting') return prev;
              if (!prev.votes[voterId]) return prev;
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
    setShowClueOption(false);
    setSelectedTimeLimit(undefined);
    setSelectedVotingTimeLimit(undefined);
    setActiveTimeTab(null);

    const initialState: GameState = {
      code,
      topic: '',
      secretWord: '',
      selectedPlayer: undefined,
      selectedPlayerClue: undefined,
      showClue: false,
      allowVoteChange: true,
      singleWordOnly: false,
      showVoteCount: true,
      hostId: playerId,
      impostorId: undefined,
      players: [hostPlayer],
      phase: 'lobby',
      currentTurnIndex: -1,
      firstSpeakerIndex: undefined,
      round: 0,
      clues: [],
      votes: {},
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
      unsubscribeFn = onValue(stateRef, (snap) => {
        if (unsubscribeFn) {
          unsubscribeFn();
          unsubscribeFn = null;
        }
        resolve(snap.val());
      }, { onlyOnce: true });
      
      // Timeout de seguridad para evitar que se quede colgado
      setTimeout(() => {
        if (unsubscribeFn) {
          unsubscribeFn();
          unsubscribeFn = null;
        }
        reject(new Error('Timeout al leer el estado de la sala'));
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
      await set(stateRef, cleanedState);
      setStatusMessage(null);
    } catch (error) {
      console.error('Error al unirse a la sala:', error);
      setStatusMessage('Error al unirse a la sala. Inténtalo de nuevo.');
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
      // Mantener el orden de llegada (no reordenar los jugadores)
      const reshuffledPlayers = prev.players.map((player) => {
        const { clue, vote, ...rest } = player;
        return {
          ...rest,
          alive: true,
          isImpostor: false,
          readyForRound: false,
        };
      });
      
      // Seleccionar impostor aleatoriamente
      const impostorIndex = Math.floor(Math.random() * reshuffledPlayers.length);
      const impostorId = reshuffledPlayers[impostorIndex].id;
      reshuffledPlayers[impostorIndex] = {
        ...reshuffledPlayers[impostorIndex],
        isImpostor: true,
      };

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
        showVoteCount: showVoteCountOption,
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
  }, [gameState, isHost, selectedTopicId, showClueOption, allowVoteChangeOption, singleWordOnlyOption, showVoteCountOption, selectedTimeLimit, selectedVotingTimeLimit, patchState]);

  // Sincronizar opciones de personalización con gameState
  useEffect(() => {
    if (gameState && isHost) {
      setAllowVoteChangeOption(gameState.allowVoteChange ?? true);
      setSingleWordOnlyOption(gameState.singleWordOnly ?? false);
      setShowVoteCountOption(gameState.showVoteCount ?? true);
    }
  }, [gameState?.allowVoteChange, gameState?.singleWordOnly, gameState?.showVoteCount, isHost]);

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
      players: prev.players.map((player) => {
        const { vote, ...rest } = player;
        return rest;
      }),
      currentTurnIndex: -1,
    }));
  }, [cluesCurrentRound.length, gameState, isHost, patchState]);

  const handleResetVotes = useCallback(() => {
    if (!isHost) return;
    patchState((prev) => ({
      ...prev,
      votes: {},
      players: prev.players.map((player) => {
        const { vote, ...rest } = player;
        return rest;
      }),
    }));
  }, [isHost, patchState]);

  const handleFinalizeVoting = useCallback(() => {
    if (!gameState || !isHost) return;
    const { targetId, tie } = resolveVotes(gameState);
    if (tie || !targetId) {
      setStatusMessage('La votación ha quedado empatada. Los jugadores pueden cambiar su voto.');
      return;
    }
    patchState((prev) => finishElimination(prev, targetId, prev.players));
  }, [gameState, isHost, patchState]);

  // Temporizador para la fase de votación
  useEffect(() => {
    if (!gameState || gameState.phase !== 'voting' || !gameState.votingTimeLimit) {
      setVotingTimeRemaining(null);
      return;
    }

    // Iniciar temporizador desde el votingTimeLimit
    setVotingTimeRemaining(gameState.votingTimeLimit);

    const interval = setInterval(() => {
      setVotingTimeRemaining((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(interval);
          // Si es el host y el tiempo se acabó, asignar votos aleatorios y cerrar votación
          if (isHost && prev !== null && prev <= 1) {
            patchState((prevState) => {
              if (prevState.phase !== 'voting') return prevState;
              
              const alivePlayers = getAlivePlayers(prevState);
              const updatedVotes = { ...prevState.votes };
              
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
                // Si el jugador ya tiene voto, mantenerlo (no cambiar votos existentes)
              });
              
              return {
                ...prevState,
                votes: updatedVotes,
              };
            });
            
            // Esperar un momento para que se actualice el estado antes de finalizar
            setTimeout(() => {
              handleFinalizeVoting();
            }, 100);
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      clearInterval(interval);
      setVotingTimeRemaining(null);
    };
  }, [gameState?.phase, gameState?.votingTimeLimit, isHost, handleFinalizeVoting, patchState]);

  const handleContinueAfterReveal = useCallback(() => {
    if (!gameState || !isHost) return;
    if (!gameState.elimination || gameState.phase !== 'reveal') return;

    patchState((prev) => {
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
        elimination: undefined,
      };
      
      // Calcular el siguiente turno usando el firstSpeakerIndex guardado
      const nextIndex = nextSpeakerIndex({ ...nextState, currentTurnIndex: -1 });
      
      // Si el juego terminó (impostor ganó o civiles ganaron), volver al lobby
      if (prev.winner) {
        return {
          ...nextState,
          phase: 'lobby' as GamePhase,
          currentTurnIndex: -1,
          topic: '',
          secretWord: '',
          selectedPlayer: undefined,
          selectedPlayerClue: undefined,
          showClue: false,
          allowVoteChange: true,
          singleWordOnly: false,
          showVoteCount: true,
          timeLimit: undefined,
          votingTimeLimit: undefined,
          impostorId: undefined,
          round: 0,
          firstSpeakerIndex: undefined,
          clues: [],
          elimination: undefined,
          winner: prev.winner, // Mantener el winner para mostrar en el lobby si es necesario
        };
      }
      
      return {
        ...nextState,
        currentTurnIndex: nextIndex,
      };
    });
  }, [gameState, isHost, patchState]);


  const handleReadyToggle = useCallback(
    (ready: boolean) => {
      // Si es el host, actualizar el estado directamente
      if (isHost && gameState) {
        patchState((prev) => {
          if (prev.phase !== 'wordReveal') return prev;
          const updatedPlayers = prev.players.map((p) =>
            p.id === playerId
              ? { ...p, readyForRound: ready }
              : p,
          );
          return { ...prev, players: updatedPlayers };
        });
      }
      // Enviar evento para que otros jugadores también se actualicen
      sendBroadcast('READY_FOR_ROUND', { playerId, ready } satisfies ReadyPayload);
    },
    [playerId, sendBroadcast, isHost, gameState, patchState],
  );

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
      sendBroadcast('SUBMIT_VOTE', { voterId: playerId, targetId } satisfies VotePayload);
    },
    [playerId, sendBroadcast],
  );

  const handleClearVote = useCallback(() => {
    sendBroadcast('CLEAR_VOTE', { playerId });
  }, [playerId, sendBroadcast]);

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
          onClick={() => {
            setStatusMessage('Próximamente: modo local en un solo dispositivo');
            setTimeout(() => setStatusMessage(null), 3000);
          }}
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
          <ul className={!isCurrentHost ? 'non-interactive' : ''}>
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
                      alt={allowVoteChangeOption ? "Cambio de voto activado" : "Cambio de voto desactivado"}
                      className="personalization-icon-img"
                    />
                  </div>
                  <span className="personalization-label">
                    {allowVoteChangeOption ? 'Cambio de voto' : 'Sin cambio'}
                  </span>
                </div>
                <div 
                  className={`personalization-button ${singleWordOnlyOption ? 'active' : 'inactive'}`}
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
                      src={singleWordOnlyOption ? "/masDeUnaPalabra.png" : "/soloUnaPalabra.png"} 
                      alt={singleWordOnlyOption ? "Palabras" : "Una palabra"}
                      className="personalization-icon-img"
                    />
                  </div>
                  <span className="personalization-label">
                    {singleWordOnlyOption ? 'Palabras' : 'Una palabra'}
                  </span>
                </div>
                <div 
                  className={`personalization-button ${showVoteCountOption ? 'active' : 'inactive'}`}
                  onClick={() => {
                    const newValue = !showVoteCountOption;
                    setShowVoteCountOption(newValue);
                    // Guardar en gameState para que los no anfitriones lo vean
                    if (isHost && gameState && patchState) {
                      patchState((prev) => ({
                        ...prev,
                        showVoteCount: newValue,
                      }));
                    }
                  }}
                >
                  <div className="personalization-icon">
                    <img 
                      src={showVoteCountOption ? "/recuentoVotos.png" : "/sinRecuentoVotos.png"} 
                      alt={showVoteCountOption ? "Recuento de votos activado" : "Recuento de votos desactivado"}
                      className="personalization-icon-img"
                    />
                  </div>
                  <span className="personalization-label">
                    {showVoteCountOption ? 'Votos visibles' : 'Votos no visibles'}
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
            <div className="summary-grid">
              <div className="summary-topic-card">
                {gameState.topic ? (
                  <>
                    <div className="summary-topic-icon">
                      {Object.values(topics).find(t => t.name === gameState.topic) && (
                        <img 
                          src={`/${Object.values(topics).find(t => t.name === gameState.topic)!.id}.png`} 
                          alt={gameState.topic}
                          className="summary-topic-icon-img"
                        />
                      )}
                    </div>
                    <span className="summary-topic-name">{gameState.topic}</span>
                  </>
                ) : (
                  <span className="summary-topic-name">No seleccionada</span>
                )}
              </div>
              <div className="summary-options-column">
                <div className={`summary-option-card ${gameState.showClue ? 'active' : 'inactive'}`}>
                  <div className="summary-option-icon">
                    <img 
                      src={gameState.showClue ? "/pista.png" : "/sinPista.png"} 
                      alt={gameState.showClue ? "Pista activada" : "Pista desactivada"}
                      className="summary-option-icon-img"
                    />
                  </div>
                  <span className="summary-option-label">{gameState.showClue ? 'Con pista' : 'Sin pista'}</span>
                </div>
                <div className={`summary-option-card ${gameState.allowVoteChange ? 'active' : 'inactive'}`}>
                  <div className="summary-option-icon">
                    <img 
                      src={gameState.allowVoteChange ? "/cambioVoto.png" : "/sinCambioVoto.png"} 
                      alt={gameState.allowVoteChange ? "Cambio de voto activado" : "Cambio de voto desactivado"}
                      className="summary-option-icon-img"
                    />
                  </div>
                  <span className="summary-option-label">{gameState.allowVoteChange ? 'Cambio de voto' : 'Sin cambio'}</span>
                </div>
                <div className={`summary-option-card ${gameState.singleWordOnly ? 'active' : 'inactive'}`}>
                  <div className="summary-option-icon">
                    <img 
                      src={gameState.singleWordOnly ? "/masDeUnaPalabra.png" : "/soloUnaPalabra.png"} 
                      alt={gameState.singleWordOnly ? "Más de una palabra" : "Solo una palabra"}
                      className="summary-option-icon-img"
                    />
                  </div>
                  <span className="summary-option-label">{gameState.singleWordOnly ? 'Más de una palabra' : 'Solo una palabra'}</span>
                </div>
                <div className={`summary-option-card ${gameState.showVoteCount ? 'active' : 'inactive'}`}>
                  <div className="summary-option-icon">
                    <img 
                      src={gameState.showVoteCount ? "/recuentoVotos.png" : "/sinRecuentoVotos.png"} 
                      alt={gameState.showVoteCount ? "Recuento de votos activado" : "Recuento de votos desactivado"}
                      className="summary-option-icon-img"
                    />
                  </div>
                  <span className="summary-option-label">{gameState.showVoteCount ? 'Votos visibles' : 'Votos no visibles'}</span>
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

    return (
      <div className="card">
        <header className="header">
          <button type="button" className="close-button" onClick={handleLeaveRoom} aria-label="Cerrar">
            ×
          </button>
        </header>
        <section className="reveal">
          <p className="topic">Temática: <strong>{gameState.topic}</strong></p>
          {currentPlayer.isImpostor ? (
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
          {countdown !== null && (
            <div className="countdown-container">
              <p className="countdown-label">Empezando en...</p>
              <div className="countdown-number">{countdown}</div>
            </div>
          )}
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
    
    // Función para obtener el texto a mostrar (pista o "-" o "[SIN RESPUESTA]")
    const getClueText = (playerId: string): string => {
      const clue = cluesMap.get(playerId);
      if (clue) return clue;
      return '-';
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
        <div className="game-info-bar">
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
        <section className="clues">
          <ul>
            {alivePlayers.map((player) => {
              const isAuthor = player.id === playerId;
              const clueWord = getClueText(player.id);
              return (
                <li key={player.id}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className="author">{player.name}</span>
                    {isAuthor && <span className="badge badge-you">Tú</span>}
                  </div>
                  <span className="word">{clueWord}</span>
                </li>
              );
            })}
          </ul>
        </section>
        {turnPlayer ? (
          <section className="turn">
            <p>
              Turno de <strong>{turnPlayer.name}</strong>
            </p>
            {gameState.timeLimit && turnTimeRemaining !== null && !hasGivenClueThisRound(gameState, turnPlayer.id) && (
              <div className="turn-timer-bar">
                <div 
                  className="turn-timer-progress" 
                  style={{ 
                    width: `${(turnTimeRemaining / gameState.timeLimit) * 100}%`,
                    transition: 'width 1s linear, background 0.5s ease',
                    background: getProgressColor(turnTimeRemaining, gameState.timeLimit)
                  }}
                />
              </div>
            )}
            {isMyTurn ? (
              <form className="form-inline" onSubmit={handleClueSubmit}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0 }}>
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
                        }
                      } else {
                        setClueInput(value);
                      }
                    }
                  }}
                    placeholder="Tu pista"
                    autoComplete="off"
                    data-form-type="other"
                    data-lpignore="true"
                    data-1p-ignore="true"
                    maxLength={30}
                  />
                  <span style={{ fontSize: '0.75rem', color: '#9ca3af', textAlign: 'right' }}>
                    {clueInput.length}/30
                  </span>
                </div>
                <button type="submit" className="primary" disabled={!clueInput.trim()}>
                  Enviar
                </button>
              </form>
            ) : (
              <p className="waiting">Esperando la pista…</p>
            )}
          </section>
        ) : (
          <p className="waiting">Todas las pistas están dadas. ¡A votar!</p>
        )}
        {isHost && (
          <footer className="footer">
            <button type="button" className="primary" onClick={handleOpenVoting}>
              Ir a votación
            </button>
          </footer>
        )}
      </div>
    );
  };

  const renderVoting = () => {
    if (!gameState || !currentPlayer) return null;

    // Obtener pistas de la ronda actual ordenadas por tiempo de creación
    const cluesOrdered = [...cluesCurrentRound].sort((a, b) => a.createdAt - b.createdAt);
    const cluesMap = new Map(cluesOrdered.map(clue => [clue.playerId, clue]));
    
    // Crear lista de jugadores con sus respuestas, ordenados por tiempo de respuesta
    const playersWithClues = cluesOrdered.map(clue => {
      const player = alivePlayers.find(p => p.id === clue.playerId);
      return player ? { player, clue: clue.word, createdAt: clue.createdAt } : null;
    }).filter((item): item is { player: typeof alivePlayers[0], clue: string, createdAt: number } => item !== null);
    
    // Añadir jugadores que no tienen pista (no debería pasar, pero por si acaso)
    const playersWithoutClues = alivePlayers
      .filter(p => !cluesMap.has(p.id))
      .map(player => ({ player, clue: '-', createdAt: Infinity }));
    
    // Combinar y ordenar todos los jugadores
    const allPlayersOrdered = [...playersWithClues, ...playersWithoutClues]
      .sort((a, b) => a.createdAt - b.createdAt);

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
          <div className="turn-timer-bar" style={{ margin: '16px 0' }}>
            <div 
              className="turn-timer-progress" 
              style={{ 
                width: `${(votingTimeRemaining / gameState.votingTimeLimit) * 100}%`,
                transition: 'width 1s linear, background 0.5s ease',
                background: getProgressColor(votingTimeRemaining, gameState.votingTimeLimit)
              }}
            />
          </div>
        )}
        <section className="clues" style={{ marginBottom: '16px' }}>
          <ul>
            {allPlayersOrdered.map(({ player, clue }) => {
              const isAuthor = player.id === playerId;
              return (
                <li key={player.id}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {isAuthor && <span className="badge badge-you">Tú</span>}
                    <span className="author">{player.name}</span>
                  </div>
                  <span className="word">{clue}</span>
                </li>
              );
            })}
          </ul>
        </section>
        <section className="vote-grid">
          {alivePlayers
            .filter(player => player.id !== playerId) // Filtrar el jugador actual
            .map((player) => {
              const votesAgainst = Object.values(gameState.votes).filter((voteTarget) => voteTarget === player.id).length;
              return (
                <button
                  type="button"
                  key={player.id}
                  className={`vote-card${currentPlayer.vote === player.id ? ' selected' : ''}`}
                  onClick={() => handleVote(player.id)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center' }}>
                    <span className="name">{player.name}</span>
                  </div>
                  {gameState.showVoteCount && <span className="count">{votesAgainst} votos</span>}
                </button>
              );
            })}
        </section>
        <footer className="footer">
          <button 
            type="button" 
            className="secondary" 
            onClick={handleClearVote}
            disabled={!gameState.allowVoteChange}
          >
            Borrar mi voto
          </button>
          {isHost && (
            <div className="host-actions">
              <button type="button" className="secondary" onClick={handleResetVotes}>
                Reiniciar votos
              </button>
              <button type="button" className="primary" onClick={handleFinalizeVoting} disabled={!allVotersSubmitted}>
                Cerrar votación
              </button>
            </div>
          )}
        </footer>
      </div>
    );
  };

  const renderReveal = () => {
    if (!gameState || !gameState.elimination) return null;
    const eliminated = gameState.players.find((player) => player.id === gameState.elimination?.targetId);
    const impostorAlive = gameState.players.some((player) => player.isImpostor && player.alive);

    return (
      <div className="card">
        <header className="header">
          <h2>Resultado</h2>
        </header>
        <section className="reveal-result">
          <h3>
            {eliminated?.name ?? 'Jugador desconocido'} era
            {gameState.elimination.wasImpostor ? ' el impostor' : ' inocente'}
          </h3>
          {gameState.elimination.wasImpostor && (
            <p>
              Palabra correcta: <strong>{gameState.secretWord}</strong>
            </p>
          )}
          {!gameState.elimination.wasImpostor && impostorAlive && (
            <p>Quedan {getAlivePlayers(gameState).length} jugadores en pie. ¡Nueva ronda!</p>
          )}
        </section>
        {isHost && (
          <footer className="footer">
            <button type="button" className="primary" onClick={handleContinueAfterReveal}>
              {gameState.elimination.wasImpostor || getAlivePlayers(gameState).length <= 2
                ? 'Volver al lobby'
                : 'Siguiente ronda'}
            </button>
            <button type="button" className="secondary" onClick={handleLeaveRoom} style={{ marginTop: '8px' }}>
              Cerrar sala
            </button>
          </footer>
        )}
      </div>
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

  return (
    <main className="app">
      {!roomCode ? renderHome() : null}
      {roomCode && (!gameState || phase === 'lobby') ? renderLobby() : null}
      {roomCode && gameState && phase === 'wordReveal' ? renderWordReveal() : null}
      {roomCode && gameState && phase === 'clue' ? renderCluePhase() : null}
      {roomCode && gameState && phase === 'voting' ? renderVoting() : null}
      {roomCode && gameState && phase === 'reveal' ? renderReveal() : null}
      {statusMessage && <div className="status">{statusMessage}</div>}
    </main>
  );
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

  if (!eliminatedPlayer) {
    return state;
  }

  const impostorWin = impostorAlive && aliveCount <= 2;
  const civiliansWin = !impostorAlive;

  let phase: GameState['phase'] = 'reveal';
  let winner: GameState['winner'] = undefined;

  // Ya no usamos la fase 'finished', volvemos al lobby cuando el juego termina
  if (impostorWin) {
    phase = 'lobby';
    winner = 'impostor';
  } else if (civiliansWin) {
    phase = 'lobby';
    winner = 'civilians';
  }

  return {
    ...state,
    players: updatedPlayers,
    phase,
    votes: {},
    elimination: {
      targetId,
      wasImpostor: !!eliminatedPlayer.isImpostor,
    },
    winner,
    currentTurnIndex: -1,
  };
};

export default App;

