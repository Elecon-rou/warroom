import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react';

type Option<T extends string> = { value: T; label: string; detail?: string; icon: LucideIcon };
type CarouselProps<T extends string> = {
  label: string;
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
};

export function Carousel<T extends string>({ label, options, value, onChange }: CarouselProps<T>) {
  const index = options.findIndex((option) => option.value === value);
  const move = (direction: number) =>
    options.length &&
    onChange(options[(index + direction + options.length) % options.length].value);
  return (
    <section className="selector-carousel" aria-label={label} aria-roledescription="carousel">
      <div className="carousel-heading">
        <span>{label}</span>
        <div className="carousel-arrows">
          <button
            type="button"
            disabled={!options.length}
            aria-label={`Previous ${label.toLowerCase()}`}
            onClick={() => move(-1)}
          >
            <ChevronLeft size={14} />
          </button>
          <button
            disabled={!options.length}
            type="button"
            aria-label={`Next ${label.toLowerCase()}`}
            onClick={() => move(1)}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
      <div className="carousel-options" role="group" aria-label={`${label} options`}>
        {options.map((option) => {
          const Icon = option.icon;
          return (
            <button
              type="button"
              key={option.value}
              aria-pressed={option.value === value}
              className={option.value === value ? 'carousel-option active' : 'carousel-option'}
              onClick={() => onChange(option.value)}
            >
              <Icon size={17} />
              <span>
                {option.label}
                {option.detail && <small>{option.detail}</small>}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
