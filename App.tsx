
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
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  // Stop alle huidige spraak
  const stopAllAudio = useCallback(() => {
    audioSourcesRef.current.forEach(s => {
      try { s.stop(); } catch(e) {}
    });
    audioSourcesRef.current.clear();
  }, []);

  // De assistent laat spreken via TTS (Kore)
  const speak = useCallback(async (text: string) => {
    stopAllAudio();
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }
    const ctx = audioContextRef.current;
    if (ctx.state === 'suspended') await ctx.resume();

    setStatus(AppStatus.READING);
    const audioData = await generateSpeech(text);
    if (audioData) {
      const buffer = await decodeAudioToBuffer(audioData, ctx);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => setStatus(AppStatus.IDLE);
      source.start(0);
      audioSourcesRef.current.add(source);
    } else {
      setStatus(AppStatus.IDLE);
    }
  }, [stopAllAudio]);

  const announceCurrentContact = useCallback(() => {
    const c = contacts[currentIndex];
    if (c) {
      speak(`${c.contactpersoon}. ${c.relatie || ''}. Onderwerp: ${c.onderwerp || 'geen'}.`);
    }
  }, [contacts, currentIndex, speak]);

  const nextContact = useCallback(() => {
    setCurrentIndex(prev => {
      const next = (prev + 1) % contacts.length;
      return next;
    });
  }, [contacts.length]);

  const prevContact = useCallback(() => {
    setCurrentIndex(prev => (prev - 1 + contacts.length) % contacts.length);
  }, [contacts.length]);

  // Effect om contact aan te kondigen als de index verandert (behalve bij eerste load)
  useEffect(() => {
    if (contacts.length > 0 && status !== AppStatus.LOADING && status !== AppStatus.DIALING) {
      announceCurrentContact();
    }
  }, [currentIndex]);

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

  const initiateCall = (phone: string) => {
    stopAllAudio();
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
              // Stuur alleen audio naar de luisteraar als de assistent zelf NIET praat
              if (status === AppStatus.IDLE) {
                const pcmBlob = createPcmBlob(inputData);
                sessionPromise.then(s => s.sendRealtimeInput({ media: pcmBlob }));
              }
            };
            source.connect(processor);
            processor.connect(inCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // BELANGRIJK: We negeren de audio-output van de Live API volledig!
            // Alleen de toolCalls (commando's) verwerken we.
            
            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                let result = "ok";
                if (fc.name === 'volgende_contact') nextContact();
                if (fc.name === 'vorige_contact') prevContact();
                if (fc.name === 'bel_huidige_persoon') {
                  const current = contacts[currentIndex];
                  initiateCall(current.telefoonnummer);
                }
                sessionPromise.then(s => s.sendToolResponse({
                  functionResponses: { id: fc.id, name: fc.name, response: { result } }
                }));
              }
            }
          }
        },
        config: {
          responseModalities: [Modality.AUDIO], // Vereist door API, maar we spelen het niet af
          systemInstruction: `Je bent een passieve luisteraar voor een handsfree bel-app.
          Luister naar commando's: 'volgende' (volgende_contact), 'vorige' (vorige_contact), 'bel' (bel_huidige_persoon).
          Reageer NOOIT met spraak. Gebruik alleen de tools.`,
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

  const handleManualStart = async () => {
    if (!liveSessionRef.current) {
      await startVoiceAssistant();
    }
    announceCurrentContact();
  };

  const currentContact = contacts[currentIndex];

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-white p-6 select-none font-sans">
      {status === AppStatus.LOADING ? (
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : (
        <div className="w-full max-w-sm flex flex-col items-center justify-between h-[85vh]">
          
          <div className="text-center pt-8">
            <div className={`text-[10px] font-black tracking-[0.2em] mb-3 transition-colors ${isListening ? 'text-green-500' : 'text-blue-600'}`}>
              {isListening ? '• HANDSFREE ACTIEF' : 'KLIK VOOR HANDSFREE'}
            </div>
            <h1 className="text-4xl font-black text-slate-900 leading-tight mb-2">
              {currentContact?.contactpersoon || 'Einde lijst'}
            </h1>
            <p className="text-slate-400 font-bold uppercase text-[10px] tracking-widest">{currentContact?.relatie}</p>
          </div>

          <button
            onClick={handleManualStart}
            disabled={status === AppStatus.DIALING}
            className={`
              relative w-64 h-64 rounded-full flex items-center justify-center transition-all duration-500 shadow-2xl active:scale-95
              ${status === AppStatus.IDLE ? 'bg-blue-600 shadow-blue-200' : 'bg-slate-50 shadow-none'}
            `}
          >
            {status === AppStatus.IDLE ? (
              <div className="flex flex-col items-center">
                <span className="text-white text-5xl font-black tracking-tighter">START</span>
                <span className="text-blue-200 text-[9px] font-black mt-2 tracking-widest uppercase">Zeg "Volgende" of "Bel"</span>
              </div>
            ) : (
              <div className="flex gap-1.5 items-center">
                <div className="w-2 h-8 bg-blue-500 rounded-full animate-[bounce_1s_infinite]"></div>
                <div className="w-2 h-14 bg-blue-500 rounded-full animate-[bounce_1s_infinite_0.2s]"></div>
                <div className="w-2 h-10 bg-blue-500 rounded-full animate-[bounce_1s_infinite_0.4s]"></div>
              </div>
            )}
            {status === AppStatus.IDLE && <div className="absolute inset-0 rounded-full bg-blue-400 animate-ping opacity-20 pointer-events-none"></div>}
          </button>

          <div className="w-full flex flex-col items-center gap-8 pb-10">
            <div className="flex gap-14 items-center">
              <button onClick={() => { stopAllAudio(); prevContact(); }} className="text-slate-200 active:text-blue-600 transition-colors">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <div className="text-center min-w-[60px]">
                <span className="block font-black text-slate-900 text-2xl tabular-nums leading-none">{currentIndex + 1}</span>
                <span className="text-[10px] font-black text-slate-300 uppercase tracking-tighter">VAN {contacts.length}</span>
              </div>
              <button onClick={() => { stopAllAudio(); nextContact(); }} className="text-slate-200 active:text-blue-600 transition-colors">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="m9 18 6-6-6-6"/></svg>
              </button>
            </div>
            
            <button onClick={() => setShowConfig(true)} className="text-slate-200 hover:text-slate-400 p-2">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
        </div>
      )}

      {showConfig && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-6 z-50 backdrop-blur-md">
          <div className="bg-white w-full max-w-sm rounded-3xl p-8 shadow-2xl">
            <h2 className="text-xl font-black mb-4">Spreadsheet URL</h2>
            <textarea 
              className="w-full h-32 p-4 bg-slate-100 rounded-xl text-sm font-mono mb-6 border-none focus:ring-2 focus:ring-blue-500"
              value={csvUrl}
              onChange={(e) => setCsvUrl(e.target.value)}
              placeholder="Plak hier je Google Sheets CSV link..."
            />
            <div className="flex gap-3">
              <button onClick={() => setShowConfig(false)} className="flex-1 py-4 font-bold text-slate-400 uppercase text-xs tracking-widest">Sluiten</button>
              <button onClick={() => { localStorage.setItem('csv_url', csvUrl); loadCSV(csvUrl); setShowConfig(false); }} className="flex-1 py-4 bg-blue-600 text-white rounded-2xl font-bold uppercase text-xs tracking-widest shadow-lg shadow-blue-200">Opslaan</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
