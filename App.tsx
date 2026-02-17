
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ContactRow, AppStatus } from './types';
import { getAIInstance, generateSpeech, decodeAudioToBuffer, createPcmBlob, decodeBase64 } from './services/geminiService';
import { Modality, Type, LiveServerMessage } from '@google/genai';

const App: React.FC = () => {
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [status, setStatus] = useState<AppStatus>(AppStatus.LOADING);
  const [errorMessage, setErrorMessage] = useState('');
  const [showConfig, setShowConfig] = useState(false);
  const [isListening, setIsListening] = useState(false);
  
  const [csvUrl, setCsvUrl] = useState(() => {
    return localStorage.getItem('csv_url') || 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSbq70IuS3Y_fD4jX0jB_vXp6i_V5_R7E7_qGv_vXp6i/pub?output=csv';
  });

  const audioContextRef = useRef<AudioContext | null>(null);
  const liveSessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  // Functies voor de AI om de app te besturen
  const nextContact = useCallback(() => {
    setCurrentIndex(prev => (prev + 1) % contacts.length);
  }, [contacts.length]);

  const prevContact = useCallback(() => {
    setCurrentIndex(prev => (prev - 1 + contacts.length) % contacts.length);
  }, [contacts.length]);

  const loadCSV = useCallback(async (url: string) => {
    try {
      setStatus(AppStatus.LOADING);
      const response = await fetch(url);
      if (!response.ok) throw new Error('Spreadsheet laden mislukt.');
      const text = await response.text();
      const lines = text.split('\n');
      const parsed = lines.slice(1).map(line => {
        const columns = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(c => c.trim().replace(/^"|"$/g, ''));
        return {
          relatie: columns[0] || '',
          contactpersoon: columns[1] || '',
          onderwerp: columns[2] || '',
          telefoonnummer: columns[3] || ''
        };
      }).filter(row => row.contactpersoon && row.telefoonnummer);
      
      setContacts(parsed);
      setStatus(AppStatus.IDLE);
    } catch (err: any) {
      setErrorMessage(err.message);
      setStatus(AppStatus.ERROR);
    }
  }, []);

  useEffect(() => { loadCSV(csvUrl); }, [loadCSV, csvUrl]);

  const stopAllAudio = () => {
    audioSourcesRef.current.forEach(s => {
      try { s.stop(); } catch(e) {}
    });
    audioSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  };

  const initiateCall = (phone: string) => {
    setStatus(AppStatus.DIALING);
    const cleanPhone = phone.replace(/[^\d+]/g, '');
    window.location.href = `tel:${cleanPhone}`;
    setTimeout(() => {
      nextContact();
      setStatus(AppStatus.IDLE);
    }, 3000);
  };

  const startVoiceAssistant = async () => {
    if (liveSessionRef.current) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setIsListening(true);

      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }
      const outCtx = audioContextRef.current;
      const inCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });

      const ai = getAIInstance();
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            const source = inCtx.createMediaStreamSource(stream);
            const processor = inCtx.createScriptProcessor(4096, 1, 1);
            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              // Stuur alleen audio naar AI als we niet zelf aan het praten zijn (voorkom echo loops)
              if (status !== AppStatus.READING) {
                const pcmBlob = createPcmBlob(inputData);
                sessionPromise.then(s => s.sendRealtimeInput({ media: pcmBlob }));
              }
            };
            source.connect(processor);
            processor.connect(inCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const audioBase64 = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioBase64) {
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outCtx.currentTime);
              const buffer = await decodeAudioToBuffer(decodeBase64(audioBase64), outCtx);
              const source = outCtx.createBufferSource();
              source.buffer = buffer;
              source.connect(outCtx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              audioSourcesRef.current.add(source);
              source.onended = () => audioSourcesRef.current.delete(source);
            }

            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                let result = "ok";
                if (fc.name === 'volgende_contact') nextContact();
                if (fc.name === 'vorige_contact') prevContact();
                if (fc.name === 'bel_huidige_persoon') {
                  initiateCall(contacts[currentIndex].telefoonnummer);
                }
                sessionPromise.then(s => s.sendToolResponse({
                  functionResponses: { id: fc.id, name: fc.name, response: { result } }
                }));
              }
            }

            if (message.serverContent?.interrupted) stopAllAudio();
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          },
          systemInstruction: `Je bent een stille handsfree assistent. Luister alleen naar commando's. 
          NIET praten tenzij je een directe vraag krijgt of een actie bevestigt. 
          Negeer achtergrondgeluiden of de stem van de assistent die informatie voorleest.
          Commando's: 'volgende_contact', 'vorige_contact', 'bel_huidige_persoon'.
          Taal: Nederlands. Stem: Kore.`,
          tools: [{
            functionDeclarations: [
              { name: 'volgende_contact', parameters: { type: Type.OBJECT, properties: {} } },
              { name: 'vorige_contact', parameters: { type: Type.OBJECT, properties: {} } },
              { name: 'bel_huidige_persoon', parameters: { type: Type.OBJECT, properties: {} } }
            ]
          }]
        }
      });

      liveSessionRef.current = await sessionPromise;
    } catch (err) {
      console.error("Microfoon fout:", err);
    }
  };

  const handleStartInteraction = async () => {
    stopAllAudio();
    if (audioContextRef.current?.state === 'suspended') {
      await audioContextRef.current.resume();
    }
    
    if (!liveSessionRef.current) {
      await startVoiceAssistant();
    }

    const current = contacts[currentIndex];
    const speakText = `${current.contactpersoon} van ${current.relatie}. Onderwerp: ${current.onderwerp}.`;
    
    setStatus(AppStatus.READING);
    const audio = await generateSpeech(speakText);
    if (audio && audioContextRef.current) {
      const buffer = await decodeAudioToBuffer(audio, audioContextRef.current);
      const source = audioContextRef.current.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContextRef.current.destination);
      source.start(0);
      source.onended = () => {
        setStatus(AppStatus.IDLE);
      };
      audioSourcesRef.current.add(source);
    }
  };

  const currentContact = contacts[currentIndex];

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-white p-6 select-none font-sans">
      {status === AppStatus.LOADING ? (
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : (
        <div className="w-full max-w-sm flex flex-col items-center justify-between h-[85vh]">
          
          <div className="text-center pt-8">
            <div className={`text-xs font-black tracking-widest mb-2 ${isListening ? 'text-green-500' : 'text-blue-600'}`}>
              {isListening ? '• LIVE ASSISTENT ACTIEF' : 'DRUK OM TE STARTEN'}
            </div>
            <h1 className="text-4xl font-black text-slate-900 leading-tight px-4">
              {currentContact?.contactpersoon || 'Lijst leeg'}
            </h1>
            <p className="text-slate-400 font-bold mt-2 uppercase text-[10px] tracking-widest">{currentContact?.relatie}</p>
          </div>

          <button
            onClick={handleStartInteraction}
            disabled={status === AppStatus.DIALING}
            className={`
              relative w-64 h-64 rounded-full flex items-center justify-center transition-all duration-500 shadow-2xl active:scale-95
              ${status === AppStatus.IDLE ? 'bg-blue-600 shadow-blue-200' : 'bg-slate-50 shadow-none'}
            `}
          >
            {status === AppStatus.IDLE ? (
              <div className="flex flex-col items-center">
                <span className="text-white text-5xl font-black tracking-tighter">START</span>
                <span className="text-blue-200 text-[10px] font-bold mt-2">ZEG "VOLGENDE" OF "BEL"</span>
              </div>
            ) : (
              <div className="flex gap-2 items-center">
                <div className="w-2 h-8 bg-blue-500 rounded-full animate-pulse"></div>
                <div className="w-2 h-12 bg-blue-500 rounded-full animate-pulse [animation-delay:0.2s]"></div>
                <div className="w-2 h-8 bg-blue-500 rounded-full animate-pulse [animation-delay:0.4s]"></div>
              </div>
            )}
            {status === AppStatus.IDLE && <div className="absolute inset-0 rounded-full bg-blue-400 animate-ping opacity-20 pointer-events-none"></div>}
          </button>

          <div className="w-full flex flex-col items-center gap-6 pb-8">
            <div className="flex gap-12 items-center text-slate-300">
              <button onClick={() => { stopAllAudio(); prevContact(); }} className="p-4 active:text-blue-600"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="m15 18-6-6 6-6"/></svg></button>
              <div className="text-center">
                <span className="block font-black text-slate-900 text-xl">{currentIndex + 1} / {contacts.length}</span>
              </div>
              <button onClick={() => { stopAllAudio(); nextContact(); }} className="p-4 active:text-blue-600"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="m9 18 6-6-6-6"/></svg></button>
            </div>
            <button onClick={() => setShowConfig(true)} className="text-slate-200"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg></button>
          </div>
        </div>
      )}

      {showConfig && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-6 z-50 backdrop-blur-sm">
          <div className="bg-white w-full max-w-sm rounded-3xl p-8 shadow-2xl">
            <h2 className="text-xl font-black mb-4 tracking-tight">CSV URL</h2>
            <textarea 
              className="w-full h-32 p-4 bg-slate-100 rounded-xl text-sm font-mono mb-6 border-none"
              value={csvUrl}
              onChange={(e) => setCsvUrl(e.target.value)}
            />
            <div className="flex gap-3">
              <button onClick={() => setShowConfig(false)} className="flex-1 py-4 font-bold text-slate-400">SLUIT</button>
              <button onClick={() => { localStorage.setItem('csv_url', csvUrl); loadCSV(csvUrl); setShowConfig(false); }} className="flex-1 py-4 bg-blue-600 text-white rounded-2xl font-bold">OPSLAAN</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
