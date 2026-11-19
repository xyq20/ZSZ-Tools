class SessionError(RuntimeError):
    """Stop the entire run until the account/session is checked."""


class ShopMismatch(SessionError):
    pass


class LoginRequired(SessionError):
    pass


class VerificationRequired(SessionError):
    pass


class UnsupportedItem(RuntimeError):
    pass


class WriteNotValidated(SessionError):
    """A write contract has not yet passed an explicitly scoped live trial."""
