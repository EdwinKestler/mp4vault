import { describe, it, expect } from 'vitest';
import { EmbedObject } from '../src/EmbedObject.js';
import { Writable } from '../src/node/Writable.js';
import { Convert } from '../src/Convert.js';

describe('EmbedObject', () => {
	it('works without encryption', async () => {
		const object = { test: '3' };
		const embedObject = new EmbedObject({ object });
		const writable = new Writable();

		await embedObject.writeTo(writable);
		const readable = await writable.toReadable();
		const restored = await EmbedObject.restoreFromReadable(readable);
		await readable.close();

		expect(restored.object!.test).toBe(object.test);
	});

	it('works with password encryption', async () => {
		const object = { test: '5' };
		const embedObject = new EmbedObject({ object, password: 'test' });
		const writable = new Writable();

		await embedObject.writeTo(writable);
		const readable = await writable.toReadable();
		const restored = await EmbedObject.restoreFromReadable(readable, { password: 'test' });
		await readable.close();

		expect(restored.object!.test).toBe(object.test);
	});

	it('works with key encryption', async () => {
		const object = { test: '5' };
		const key = Convert.hexStringToBuffer('000102030405060708090a0b0c0d0e0f');
		const embedObject = new EmbedObject({ object, key });
		const writable = new Writable();

		await embedObject.writeTo(writable);
		const readable = await writable.toReadable();
		const restored = await EmbedObject.restoreFromReadable(readable, { key });
		await readable.close();

		expect(restored.object!.test).toBe(object.test);
	});

	it('handles huge objects with key encryption', async () => {
		const object: Record<string, unknown> = { test: '13', somearray: [] as number[], someother: [] as string[], subobject: {} as Record<string, unknown> };
		for (let i = 0; i < 1000; i++) {
			(object.somearray as number[]).push(i);
			(object.someother as string[]).push('👙');
			(object.subobject as Record<string, unknown>)['property_' + i] = { t: 'test_' + i };
		}

		const key = Convert.hexStringToBuffer('000102030405060708090a0b0c0d0e0f');
		const embedObject = new EmbedObject({ object, key });
		const writable = new Writable();

		await embedObject.writeTo(writable);
		const readable = await writable.toReadable();
		const restored = await EmbedObject.restoreFromReadable(readable, { key });
		await readable.close();

		const obj = restored.object as Record<string, unknown>;
		expect(obj.test).toBe('13');
		expect((obj.somearray as number[]).length).toBe(1000);
		expect((obj.someother as string[]).length).toBe(1000);
		expect((obj.someother as string[])[0]).toBe('👙');
		expect((obj.someother as string[])[999]).toBe('👙');
		expect(((obj.subobject as Record<string, { t: string }>).property_0).t).toBe('test_0');
		expect(((obj.subobject as Record<string, { t: string }>).property_999).t).toBe('test_999');
	});

	it('handles multiple objects at offsets', async () => {
		const object = { test: '5' };
		const object2 = { test2: '53' };
		const key = Convert.hexStringToBuffer('000102030405060708090a0b0c0d0e0f');
		const embedObject = new EmbedObject({ object, key });
		const expectedSize = await embedObject.getExpectedSize();
		const embedObject2 = new EmbedObject({ object: object2, key });
		const writable = new Writable();

		await writable.write(new Uint8Array(100000));
		await embedObject.writeTo(writable);
		await writable.write(new Uint8Array(100000));
		await embedObject2.writeTo(writable);
		await writable.write(new Uint8Array(100000));

		expect(writable.size()).toBeGreaterThan(300000);

		const readable = await writable.toReadable();
		const restored = await EmbedObject.restoreFromReadable(readable, { key }, 100000);
		const restored2 = await EmbedObject.restoreFromReadable(readable, { key }, 100000 + 100000 + expectedSize);
		await readable.close();

		expect(restored.object!.test).toBe(object.test);
		expect(restored2.object!.test2).toBe(object2.test2);
	});
});
