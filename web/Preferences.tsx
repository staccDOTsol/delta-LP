import type { Preference } from '../waitlist/preferences.ts';

const fuelNames = { 'heating-oil':'Heating oil', propane:'Propane', 'natural-gas':'Natural gas' };
const directionNames = { neutral:'Delta neutral', long:'Long', short:'Short' };
export const initialPreference: Preference = { product:'strategy', direction:'neutral', leverage:3 };

export function preferenceLabel(value: Preference | null) {
  if (!value) return 'No preference selected';
  return value.product === 'strategy'
    ? `${directionNames[value.direction]} · ${value.leverage}× interest`
    : `${fuelNames[value.fuel]} subscription${value.region ? ` · ${value.region}` : ''}`;
}

export function Preferences({ value, onChange, oilOnly=false }: { value:Preference; onChange:(next:Preference)=>void; oilOnly?:boolean }) {
  return <div className="preferences">
    {!oilOnly ? <fieldset className="product-choice"><legend>What brings you here?</legend>
      <label className={value.product === 'strategy' ? 'selected' : ''}><input type="radio" name="product" value="strategy" checked={value.product === 'strategy'} onChange={()=>onChange(initialPreference)}/><span>Trading strategies<small>Neutral · long · short</small></span></label>
      <label className={value.product === 'oil-subscription' ? 'selected' : ''}><input type="radio" name="product" value="oil-subscription" checked={value.product === 'oil-subscription'} onChange={()=>onChange({product:'oil-subscription',fuel:'heating-oil',region:''})}/><span>Oil & gas subscriptions<small>Plan ahead for winter</small></span></label>
    </fieldset> : null}
    {value.product === 'strategy' ? <>
      <div className="preference-fields"><label>Strategy<select value={value.direction} onChange={event=>onChange({...value,direction:event.target.value as 'neutral'|'long'|'short'})}><option value="neutral">Delta neutral</option><option value="long">Long</option><option value="short">Short</option></select></label>
      <label>Leverage interest<select value={value.leverage} onChange={event=>onChange({...value,leverage:Number(event.target.value) as 3|5|10})}><option value={3}>3×</option><option value={5}>5×</option><option value={10}>10×</option></select></label></div>
      <p className="preference-note">Tell us what you want to use. These strategies and leverage levels are planned, and trading is not open. Leverage magnifies losses; directional long/short exposure is not delta neutral.</p>
    </> : <>
      <label className="preference-field">Fuel type<select value={value.fuel} onChange={event=>onChange({...value,fuel:event.target.value as 'heating-oil'|'propane'|'natural-gas'})}><option value="heating-oil">Heating oil</option><option value="propane">Propane</option><option value="natural-gas">Natural gas</option></select></label>
      <label className="preference-field">City or region <span>(optional)</span><input type="text" value={value.region} onChange={event=>onChange({...value,region:event.target.value})} maxLength={80} autoComplete="address-level2" placeholder="e.g. Halifax, Nova Scotia"/></label>
      <p className="preference-note">Register interest in seasonal fuel budgeting. Service areas, supplier agreements, pricing, and delivery dates are not yet confirmed. No subscription is purchased.</p>
    </>}
  </div>;
}
