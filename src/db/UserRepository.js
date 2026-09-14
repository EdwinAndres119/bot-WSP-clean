class UserRepository {
    constructor(supabase) {
        this.supabase = supabase;
    }

    async findByEmail(email) {
        const { data, error } = await this.supabase
            .from('users')
            .select('*')
            .eq('email', email)
            .maybeSingle();

        if (error) {
            console.error('Error al buscar usuario por email:', error.message);
            return null;
        }
        return data;
    }

    async findById(id) {
        const { data, error } = await this.supabase
            .from('users')
            .select('id, name, phone, email')
            .eq('id', id)
            .maybeSingle();

        if (error) {
            console.error('Error al buscar usuario por id:', error.message);
            return null;
        }
        return data;
    }

    // Returns null on success (id of the created user), or 'duplicate' if the
    // email is already taken (Postgres unique_violation, code 23505).
    async create({ name, phone, email, passwordHash }) {
        const { data, error } = await this.supabase
            .from('users')
            .insert({ name, phone, email, password_hash: passwordHash })
            .select('id')
            .single();

        if (error) {
            if (error.code === '23505') return { duplicate: true };
            console.error('Error al crear usuario:', error.message);
            return { error: error.message };
        }
        return { id: data.id };
    }
}

module.exports = UserRepository;
