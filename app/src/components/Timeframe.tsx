type Props = {
  value: string;
  onChange: (v: string) => void;
};

export function Timeframe({ value, onChange }: Props) {
  const options = ['1M', '3M', '6M', 'YTD', '1Y', '3Y', '5Y', 'ALL'];
  return (
    <div className="timeframe">
      {options.map(o => (
        <button key={o} className={value === o ? 'active' : ''} onClick={() => onChange(o)}>
          {o}
        </button>
      ))}
    </div>
  );
}
