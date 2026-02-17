
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ContactRow, AppStatus } from './types';
import { generateSpeech, decodeAudioToBuffer } from './services/geminiService';

const App: React.FC = () => {
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [status, setStatus] = useState<AppStatus>(AppStatus.LOADING);
  const [errorMessage, setErrorMessage] = useState('');
  const [showConfig, setShowConfig] = useState(false);
  
  const [csvUrl, setCsvUrl] = useState(() => {
    return localStorage.getItem('csv_url') || 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSbq70IuS3Y_fD4jX0jB_vXp6i_V5_R7E7_qGv_vXp6i/pub?output=csv';
  });

  const audioContextRef = useRef<AudioContext | null>(null);

  const parseCSV = (csv: string): ContactRow[] => {
    const lines = csv.split('\n');
    return lines.slice(1).map(line => {
      const columns = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(c => c.trim().replace(/^"|"$/g, ''));
      return {
        relatie: columns[0] || '',
        contactpersoon: columns[1] || '',
        onderwerp: columns[2] || '',
        telefoonnummer: columns[3] || ''
      };
    }).filter(row => row.contactpersoon && row.telefoonnummer);
  };

  const loadCSV = useCallback(async (url: string) => {
    try {
      setStatus(AppStatus.LOADING);
      const response = await fetch(url);
      if (!response.ok) throw new Error('Spreadsheet laden mislukt. Controleer de URL.');
      const text = await response.text();
      const parsed = parseCSV(text);
      if (parsed.length === 0) throw new Error('Geen contacten gevonden in de spreadsheet.');
      setContacts(parsed);
      setStatus(AppStatus.IDLE);
    } catch (err: any) {
      setErrorMessage(err.message);
      setStatus(AppStatus.ERROR);
    }
  }, []);

  useEffect(() => {
    loadCSV(csvUrl);
  }, [loadCSV, csvUrl]);

  const saveUrl = () => {
    localStorage.setItem('csv_url', csvUrl);
    loadCSV(csvUrl);
    setShowConfig(false);
  };

  const handleStart = async () => {
    if (contacts.length === 0 || status !== AppStatus.IDLE) return;
    const current = contacts[currentIndex];
    
    try {
      setStatus(AppStatus.READING);

      const speakText = `Relatie: ${current.relatie}. Contactpersoon: ${current.contactpersoon}. Onderwerp: ${current.onderwerp}.`;

      const audioData = await generateSpeech(speakText);
      if (!audioData) throw new Error('Spraak genereren mislukt.');

      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }
      const ctx = audioContextRef.current;
      
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      const buffer = await decodeAudioToBuffer(audioData, ctx);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      
      source.onended = () => {
        initiateCall(current.telefoonnummer);
      };

      source.start(0);

    } catch (err: any) {
      console.error(err);
      setErrorMessage('Fout bij het voorlezen. Controleer je API sleutel.');
      setStatus(AppStatus.ERROR);
    }
  };

  const initiateCall = (phone: string) => {
    setStatus(AppStatus.DIALING);
    const cleanPhone = phone.replace(/[^\d+]/g, '');
    window.location.href = `tel:${cleanPhone}`;
    
    setTimeout(() => {
      setCurrentIndex((prev) => (prev + 1) % contacts.length);
      setStatus(AppStatus.IDLE);
    }, 3000);
  };

  if (status === AppStatus.ERROR) {
    return (
      <div className="min-h-screen flex items-center justify-center p-10 bg-red-50 text-center font-sans">
        <div className="max-w-xs">
          <p className="text-red-600 font-bold mb-6 text-lg">{errorMessage}</p>
          <button 
            onClick={() => { setErrorMessage(''); setStatus(AppStatus.IDLE); }} 
            className="bg-red-600 text-white w-full py-4 rounded-2xl font-black shadow-lg active:scale-95 transition-transform"
          >
            PROBEER OPNIEUW
          </button>
          <button 
            onClick={() => setShowConfig(true)} 
            className="mt-4 text-red-400 font-bold text-sm"
          >
            URL aanpassen
          </button>
        </div>
        {showConfig && renderConfigModal()}
      </div>
    );
  }

  function renderConfigModal() {
    return (
      <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-6 z-50 backdrop-blur-sm">
        <div className="bg-white w-full max-w-sm rounded-3xl p-8 shadow-2xl">
          <h2 className="text-xl font-black mb-4">Instellingen</h2>
          <label className="block text-sm font-bold text-slate-500 mb-2">CSV URL van Google Sheets:</label>
          <textarea 
            className="w-full h-32 p-4 bg-slate-100 rounded-xl text-sm font-mono mb-6 outline-blue-500 border-none"
            value={csvUrl}
            onChange={(e) => setCsvUrl(e.target.value)}
          />
          <p className="text-[10px] text-slate-400 mb-6 leading-relaxed">
            Zorg dat je spreadsheet is gedeeld via Bestand &gt; Delen &gt; Publiceren op internet. 
            Kies &apos;Door komma&apos;s gescheiden waarden (.csv)&apos; en kopieer die link hierboven.
          </p>
          <div className="flex gap-3">
            <button onClick={() => setShowConfig(false)} className="flex-1 py-4 font-bold text-slate-400">ANNULEER</button>
            <button onClick={saveUrl} className="flex-1 py-4 bg-blue-600 text-white rounded-2xl font-bold shadow-blue-200 shadow-lg">OPSLAAN</button>
          </div>
        </div>
      </div>
    );
  }

  const currentContact = contacts[currentIndex];

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-white p-6 select-none touch-none font-sans">
      {status === AppStatus.LOADING ? (
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin"></div>
          <div className="text-slate-300 font-black tracking-widest text-sm">CONTACTEN LADEN...</div>
        </div>
      ) : (
        <div className="w-full max-w-sm flex flex-col items-center justify-between h-[80vh]">
          <div className="text-center pt-12">
            <p className="text-blue-600 font-black text-xs tracking-widest mb-2">VOLGENDE CONTACT</p>
            <h1 className="text-5xl md:text-6xl font-black text-slate-900 leading-tight break-words">
              {currentContact?.contactpersoon || 'Einde lijst'}
            </h1>
          </div>

          <button
            onClick={handleStart}
            disabled={status !== AppStatus.IDLE}
            className={`
              relative w-64 h-64 rounded-full flex items-center justify-center transition-all duration-500 shadow-2xl active:scale-90
              ${status === AppStatus.IDLE ? 'bg-blue-600 shadow-blue-200' : 'bg-slate-100 shadow-none scale-95'}
            `}
          >
            {status === AppStatus.IDLE ? (
              <span className="text-white text-5xl font-black tracking-tighter">START</span>
            ) : (
              <div className="flex gap-2">
                <div className="w-4 h-12 bg-blue-500 rounded-full animate-bounce"></div>
                <div className="w-4 h-12 bg-blue-500 rounded-full animate-bounce [animation-delay:0.2s]"></div>
                <div className="w-4 h-12 bg-blue-500 rounded-full animate-bounce [animation-delay:0.4s]"></div>
              </div>
            )}
            
            {status === AppStatus.IDLE && (
              <div className="absolute inset-0 rounded-full bg-blue-400 animate-ping opacity-20 pointer-events-none"></div>
            )}
          </button>

          <div className="w-full flex flex-col items-center gap-8 pb-12">
            <div className="flex gap-12 items-center text-slate-300">
              <button onClick={() => setCurrentIndex(i => (i - 1 + contacts.length) % contacts.length)} className="p-4 active:text-blue-600 transition-colors">
                 <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <div className="flex flex-col items-center">
                <span className="font-black text-slate-900 text-lg tabular-nums leading-none">{currentIndex + 1}</span>
                <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest mt-1">VAN {contacts.length}</span>
              </div>
              <button onClick={() => setCurrentIndex(i => (i + 1) % contacts.length)} className="p-4 active:text-blue-600 transition-colors">
                 <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6"/></svg>
              </button>
            </div>
            
            <button onClick={() => setShowConfig(true)} className="text-slate-200 hover:text-slate-400 transition-colors">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
        </div>
      )}

      {showConfig && renderConfigModal()}
    </div>
  );
};

export default App;
