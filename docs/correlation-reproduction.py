"""Reproduce the correlation fallback shown in the supplied 19 September log.

Run with Python 3: python ITISYOU_Verify_Correlation_Reproduction.py
No network, credentials, packages or application database are used.

This deliberately tests the PASTED implementation, not the current application.
Expected result for that implementation: 8 tests, 4 assertion failures, exit 1.
The failures demonstrate why exact ID binding needs deployed regression tests.
Passing this isolated reproduction after changing it would not prove a release.
"""

import json
import sqlite3
import unittest

# These SELECT statements reproduce the queries in the supplied patch.
BY_ID = """
SELECT r.id AS id
FROM runs r
JOIN source_events se
  ON se.id = r.source_event_id AND se.workspace_id = r.workspace_id
WHERE r.workspace_id = ?
  AND r.status = 'PENDING'
  AND json_extract(se.payload_json, '$.expected.email_message_id') = ?
LIMIT 2
"""

BY_RECIPIENT = """
SELECT r.id AS id
FROM runs r
JOIN source_events se
  ON se.id = r.source_event_id AND se.workspace_id = r.workspace_id
WHERE r.workspace_id = ?
  AND r.status = 'PENDING'
  AND lower(trim(json_extract(se.payload_json, '$.expected.email_recipient'))) = ?
LIMIT 2
"""


class CorrelationReproduction(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.executescript('''
            CREATE TABLE runs (
                id TEXT, workspace_id TEXT, status TEXT, source_event_id TEXT
            );
            CREATE TABLE source_events (
                id TEXT, workspace_id TEXT, payload_json TEXT
            );
        ''')

    def tearDown(self):
        self.db.close()

    def seed(self, run_id, message_id, recipient, status='PENDING'):
        payload = {'expected': {'email_recipient': recipient}}
        if message_id is not None:
            payload['expected']['email_message_id'] = message_id
        self.db.execute('INSERT INTO source_events VALUES (?, ?, ?)',
                        (run_id, 'workspace', json.dumps(payload)))
        self.db.execute('INSERT INTO runs VALUES (?, ?, ?, ?)',
                        (run_id, 'workspace', status, run_id))

    def correlate_as_pasted(self, message_id, recipient):
        def unique(sql, value):
            rows = self.db.execute(sql, ('workspace', value)).fetchall()
            return rows[0][0] if len(rows) == 1 else None
        result = unique(BY_ID, message_id)
        if result is not None:
            return result
        recipient = (recipient or '').strip().lower()
        if not recipient:
            return None
        return unique(BY_RECIPIENT, recipient)

    def test_R01_exact_message_matches(self):
        self.seed('A', 'M1', 'a@example.test')
        self.assertEqual(self.correlate_as_pasted('M1', 'a@example.test'), 'A')

    def test_R02_same_recipient_different_ids(self):
        self.seed('A', 'M1', 'a@example.test')
        self.seed('B', 'M2', 'a@example.test')
        self.assertEqual(self.correlate_as_pasted('M2', 'a@example.test'), 'B')

    def test_R03_wrong_id_cannot_fall_back_to_address(self):
        self.seed('A', 'M1', 'a@example.test')
        self.assertIsNone(self.correlate_as_pasted('UNRELATED', 'a@example.test'))

    def test_R04_ambiguous_id_cannot_fall_back_to_address(self):
        self.seed('A', 'M1', 'a@example.test')
        self.seed('B', 'M1', 'b@example.test')
        self.assertIsNone(self.correlate_as_pasted('M1', 'a@example.test'))

    def test_R05_old_delivery_cannot_attach_to_new_pending_run(self):
        self.seed('A', 'M1', 'a@example.test', status='VERIFIED')
        self.seed('B', 'M2', 'a@example.test')
        self.assertIsNone(self.correlate_as_pasted('M1', 'a@example.test'))

    def test_R06_address_alone_does_not_prove_an_enquiry(self):
        self.seed('A', None, 'a@example.test')
        self.assertIsNone(self.correlate_as_pasted('UNRELATED', 'a@example.test'))

    def test_R07_correct_id_preserves_recipient_contradiction(self):
        self.seed('A', 'M1', 'a@example.test')
        # Binding must still reach A so its separate evaluator can reject the address.
        # This isolated test does not execute that evaluator.
        self.assertEqual(self.correlate_as_pasted('M1', 'wrong@example.test'), 'A')

    def test_R08_two_address_only_candidates_stay_ambiguous(self):
        self.seed('A', None, 'a@example.test')
        self.seed('B', None, 'a@example.test')
        self.assertIsNone(self.correlate_as_pasted('UNRELATED', 'a@example.test'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
