export default function Loading() {
  return (
    <div className="route-loading">
      <div className="route-loading__header" />
      <div className="route-loading__nav" />
      <div className="route-loading__card">
        <div className="route-loading__line route-loading__line--wide" />
        <div className="route-loading__table">
          {Array.from({ length: 8 }, (_, index) => (
            <div className="route-loading__row" key={index}>
              <span />
              <span />
              <span />
              <span />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
