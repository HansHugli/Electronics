import { useState, useEffect } from 'react';

const QUOTES = [
  { text: "The scientists of today think deeply instead of clearly. One must be sane to think clearly, but one can think deeply and be quite insane.", author: "Nikola Tesla" },
  { text: "The present is theirs; the future, for which I really worked, is mine.", author: "Nikola Tesla" },
  { text: "If you only knew the magnificence of the 3, 6 and 9, then you would have the key to the universe.", author: "Nikola Tesla" },
  { text: "I do not think there is any thrill that can go through the human heart like that felt by the inventor as he sees some creation of the brain unfolding to success.", author: "Nikola Tesla" },
  { text: "Every day sees humanity more victorious in the struggle with space and time.", author: "Guglielmo Marconi" },
  { text: "The coming of the wireless era will make war impossible, because it will make war ridiculous.", author: "Guglielmo Marconi" },
  { text: "An inventor is simply a fellow who doesn't take his education too seriously.", author: "Charles Kettering" },
  { text: "I have not failed. I've just found 10,000 ways that won't work.", author: "Thomas Edison" },
  { text: "There is no substitute for hard work.", author: "Thomas Edison" },
  { text: "Genius is one percent inspiration and ninety-nine percent perspiration.", author: "Thomas Edison" },
  { text: "The best way to predict the future is to invent it.", author: "Alan Kay" },
  { text: "Any sufficiently advanced technology is indistinguishable from magic.", author: "Arthur C. Clarke" },
  { text: "The important thing in science is not so much to obtain new facts as to discover new ways of thinking about them.", author: "William Lawrence Bragg" },
  { text: "What one fool can do, another can.", author: "Ancient Simian Proverb, as quoted by Silvanus P. Thompson" },
  { text: "Electricity is really just organized lightning.", author: "George Carlin" },
  { text: "The radio craze will die out in time.", author: "Thomas Edison, 1922" },
  { text: "In the space of one hundred and seventy-six years the Lower Mississippi has shortened itself two hundred and forty-two miles. Therefore, in the Old Oolitic Silurian Period the Lower Mississippi River was upwards of one million three hundred thousand miles long. Seven hundred and forty-two years from now the Lower Mississippi will be only a mile and three-quarters long.", author: "Mark Twain (on extrapolation)" },
];

function getRandomQuote() {
  return QUOTES[Math.floor(Math.random() * QUOTES.length)];
}

interface AboutDialogProps {
  onClose: () => void;
}

export default function AboutDialog({ onClose }: AboutDialogProps) {
  const [version, setVersion] = useState('');
  const [quote] = useState(getRandomQuote);

  useEffect(() => {
    if (window.electronApi?.getVersion) {
      window.electronApi.getVersion().then(setVersion);
    } else {
      setVersion('dev');
    }
  }, []);

  return (
    <div className="modal-overlay">
      <div className="modal about-modal">
        <div className="about-icon">
          <img src="./icon.png" alt="E101" width={64} height={64} onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
          }} />
        </div>
        <h2 className="about-title">E101 Electronics Simulator</h2>
        <span className="about-version">v{version}</span>
        <div className="about-quote">
          <p className="about-quote-text">&ldquo;{quote.text}&rdquo;</p>
          <p className="about-quote-author">&mdash; {quote.author}</p>
        </div>
        <div className="about-footer">
          <span className="about-tech">React + TypeScript + Electron</span>
          <button type="button" className="modal-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
