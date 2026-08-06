package events

import "encoding/json"

// Passthrough support for the loose payloads in the contract.
//
// cdr.leg.write is a z.looseObject on the TypeScript side (see cdr-events.ts): the schema pins the
// columns billing, reporting and retention key off, and passes everything else THROUGH to the CDR
// writer, which owns the column list. Go's encoding/json would silently drop those keys, so the
// generated struct carries an Extra map and the two helpers below reunite it with the wire form.
//
// Pinned fields always win on marshal: a producer that puts a value in Extra under a pinned key has
// a bug, and letting it override the typed field would make the struct lie.

func marshalWithExtras(value any, extras map[string]json.RawMessage) ([]byte, error) {
	base, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if len(extras) == 0 {
		return base, nil
	}
	var merged map[string]json.RawMessage
	if err := json.Unmarshal(base, &merged); err != nil {
		return nil, err
	}
	for key, raw := range extras {
		if _, pinned := merged[key]; pinned {
			continue
		}
		merged[key] = raw
	}
	// encoding/json sorts map keys, so the output is deterministic regardless of map order.
	return json.Marshal(merged)
}

func unmarshalWithExtras(
	data []byte,
	value any,
	known map[string]struct{},
) (map[string]json.RawMessage, error) {
	if err := json.Unmarshal(data, value); err != nil {
		return nil, err
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(data, &all); err != nil {
		return nil, err
	}
	var extras map[string]json.RawMessage
	for key, raw := range all {
		if _, pinned := known[key]; pinned {
			continue
		}
		if extras == nil {
			extras = make(map[string]json.RawMessage, len(all)-len(known))
		}
		extras[key] = raw
	}
	return extras, nil
}
